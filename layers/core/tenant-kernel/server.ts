// Single-mode `#tenant/server` kernel.
//
// The tenancy layer (when present) overrides this file via a Nuxt alias. App
// layer server code imports from `#tenant/server` and never knows which side.
//
// Single-mode contract:
//   - `defineTenantHandler` runs `requireAuth`, opens a Kysely transaction,
//     resolves the user's permission set from `users.roles[]` unioned with
//     their direct grants (`user_permission_grants`), then calls the handler.
//     There is no `app.current_org` GUC, no app-enable check, no per-org
//     overlay.
//   - An OAuth bearer token signs in in place of the session (see
//     `bearer-auth.ts`): the route must name a permission the token carries,
//     and `ctx.perms` is narrowed to the token's scopes.
//   - `encodeFlowOrg` / `decodeFlowOrg` are no-ops — OAuth `state` carries
//     whatever the caller put in it.
//   - `requireOperatorAdmin` checks `users.is_admin`. Same in both modes; the
//     thing tenancy adds on top is BYPASSRLS DB-role plumbing for cross-org
//     reach.

import type { H3Event, EventHandler, EventHandlerRequest } from 'h3'
import type { Transaction, Kysely } from 'kysely'
import { db } from '#core/server/utils/database'
// Tracks each request transaction so `afterCommit` work runs once it commits.
import { runTransaction } from '#core/server/utils/after-commit'
import { requireAuth } from '#core/server/utils/auth'
import { getBearerIdentity, narrowToScopes, requireBearerPermission, runAsOauthClient } from '#core/server/utils/bearer-auth'
import { getRolePermissions } from '#core/server/utils/rbac'
import { getUserGrantedPermissions } from '#core/server/utils/permission-grants'
import { getPersonalAppPermissions } from '#core/server/utils/personal-apps'
import type { Database } from '#core/server/database/schema'
import type { Permission } from '#core/app/utils/permissions'

export interface TenantContext {
  userId: string
  orgId: string | null
  orgSlug: string | null
  // `role` is always null in single mode (it's the membership shorthand in
  // multi mode). `roles` is the user's full host role list — `users.roles[]`,
  // plus `admin` when `is_admin` is set.
  role: string | null
  roles: string[]
  // Effective permissions: union(role perms) ∪ direct user grants, narrowed
  // to the token's scopes for an OAuth request.
  perms: Set<Permission>
  // The OAuth client making the request; null for a session request.
  clientId: string | null
}

export interface DefineTenantHandlerOpts {
  appId?: string
  // Org slug an OAuth request selects (multi mode). Single mode has one
  // tenant and ignores it.
  org?: string
}

export type TenantHandler<T> = (
  tx: Transaction<Database>,
  ctx: TenantContext
) => Promise<T> | T

// The single-mode permission set: `users.roles[]` (plus `admin` when
// `is_admin`) resolved through `getRolePermissions`, unioned with the user's
// direct grants. The grants table is global in single mode, so the user_id
// filter is the whole scope.
async function resolveSinglePerms(
  client: Kysely<Database> | Transaction<Database>,
  userId: string
): Promise<{ roles: string[], perms: Set<Permission> }> {
  const userRow = await client
    .selectFrom('users')
    .select(['is_admin', 'roles'])
    .where('id', '=', userId)
    .executeTakeFirst()

  const roles = [...(userRow?.roles ?? [])]
  if (userRow?.is_admin && !roles.includes('admin')) roles.push('admin')

  const perms = await getRolePermissions(client, roles, null)
  for (const perm of await getUserGrantedPermissions(client, userId)) {
    perms.add(perm)
  }
  return { roles, perms }
}

// `perm` is the permission the route is gated on, which an OAuth request
// must carry as a scope.
async function runWithSingleContext<T>(
  event: H3Event,
  perm: Permission | undefined,
  fn: TenantHandler<T>
): Promise<T> {
  const bearer = await getBearerIdentity(event)
  if (bearer) requireBearerPermission(event, bearer, perm)
  const userId = bearer?.userId ?? requireAuth(event).userId
  const clientId = bearer?.clientId ?? null
  return await runAsOauthClient(clientId, () => runTransaction(db, async (tx) => {
    const { roles, perms } = await resolveSinglePerms(tx, userId)
    return await fn(tx, {
      userId,
      orgId: null,
      orgSlug: null,
      role: null,
      roles,
      perms: bearer ? narrowToScopes(perms, bearer.scopes) : perms,
      clientId
    })
  }))
}

export function defineTenantHandler<T>(fn: TenantHandler<T>): EventHandler<EventHandlerRequest, Promise<T>>
export function defineTenantHandler<T>(opts: DefineTenantHandlerOpts, fn: TenantHandler<T>): EventHandler<EventHandlerRequest, Promise<T>>
export function defineTenantHandler<T>(
  optsOrFn: DefineTenantHandlerOpts | TenantHandler<T>,
  maybeFn?: TenantHandler<T>
): EventHandler<EventHandlerRequest, Promise<T>> {
  const fn = (typeof optsOrFn === 'function' ? optsOrFn : maybeFn) as TenantHandler<T>
  return defineEventHandler<EventHandlerRequest, Promise<T>>(event => runWithSingleContext(event, undefined, fn))
}

// Function-call style — for handlers already wrapped in `defineEventHandler`.
// Same semantics as `defineTenantHandler`. Single-mode ignores `opts.appId`
// (no app-enable check exists in single deploys).
export function withOrgContext<T>(
  event: H3Event,
  fn: TenantHandler<T>
): Promise<T>
export function withOrgContext<T>(
  event: H3Event,
  opts: DefineTenantHandlerOpts,
  fn: TenantHandler<T>
): Promise<T>
export function withOrgContext<T>(
  event: H3Event,
  optsOrFn: DefineTenantHandlerOpts | TenantHandler<T>,
  maybeFn?: TenantHandler<T>
): Promise<T> {
  const fn = (typeof optsOrFn === 'function' ? optsOrFn : maybeFn) as TenantHandler<T>
  return runWithSingleContext(event, undefined, fn)
}

// Same as `withOrgContext` plus a permission gate on `ctx.perms`.
export function withOrgPermission<T>(
  event: H3Event,
  perm: Permission,
  fn: TenantHandler<T>
): Promise<T>
export function withOrgPermission<T>(
  event: H3Event,
  opts: DefineTenantHandlerOpts,
  perm: Permission,
  fn: TenantHandler<T>
): Promise<T>
export function withOrgPermission<T>(
  event: H3Event,
  a: Permission | DefineTenantHandlerOpts,
  b: Permission | TenantHandler<T>,
  c?: TenantHandler<T>
): Promise<T> {
  const hasOpts = typeof a === 'object'
  const perm = (hasOpts ? b : a) as Permission
  const fn = (hasOpts ? c : b) as TenantHandler<T>
  return runWithSingleContext(event, perm, async (tx, ctx) => {
    if (!ctx.perms.has(perm)) {
      throw createError({ statusCode: 403, statusMessage: `Permission required: ${perm}` })
    }
    return await fn(tx, ctx)
  })
}

// Every permission the user holds anywhere in the deployment, resolved
// outside a request. The OAuth layer uses it as the upper bound for consent
// and token issuance; the MCP layer uses it for tools/list visibility. Single
// mode has one tenant, so this is the set `defineTenantHandler` computes plus
// the permissions of the user's personal apps.
export async function getUserPermissionsAcrossOrgs(userId: string): Promise<Set<Permission>> {
  const { perms } = await resolveSinglePerms(db, userId)
  for (const perm of await getPersonalAppPermissions(db, userId)) perms.add(perm)
  return perms
}

// The user's effective permissions for the org a request targets. Single
// mode has no orgs, so `opts.org` is accepted for API compatibility with the
// multi-mode kernel and ignored.
export async function getUserPermissionsForRequest(
  _event: H3Event,
  userId: string,
  _opts: { org?: string } = {}
): Promise<Set<Permission>> {
  return await getUserPermissionsAcrossOrgs(userId)
}

// App ids switched on for the org a request targets, or null when there is
// no org to check. Single deploys have no per-org app switch, so always null.
export async function getEnabledAppsForRequest(
  _event: H3Event,
  _userId: string,
  _opts: { org?: string } = {}
): Promise<Set<string> | null> {
  return null
}

export interface UserOrg {
  id: string
  slug: string
  name: string
  perms: Set<Permission>
}

export interface UserOrgsFilter {
  permission?: Permission
  appId?: string
  orgIds?: string[]
}

// The user's orgs. Single mode has none.
export async function listUserOrgs(_userId: string, _filter: UserOrgsFilter = {}): Promise<UserOrg[]> {
  return []
}

export interface OrgScopesFilter {
  activeOnly?: boolean
  appId?: string
}

// The org scopes a session-less job visits: one, with no org, in single mode.
export async function listOrgScopes(_filter: OrgScopesFilter = {}): Promise<(string | null)[]> {
  return [null]
}

// Runs `fn` in a transaction. The multi-mode kernel also sets the org GUC.
export async function withOrgScope<T>(
  _orgId: string | null,
  fn: (tx: Transaction<Database>) => Promise<T>
): Promise<T> {
  return await runTransaction(db, fn)
}

// Operator-admin gate. Same in single and multi modes — the bit on the user
// row is the source of truth. Tenancy layer adds BYPASSRLS DB-role plumbing
// on top for endpoints that need to read across orgs.
export async function requireOperatorAdmin(event: H3Event): Promise<{ userId: string }> {
  const authUser = requireAuth(event)
  const user = await db
    .selectFrom('users')
    .select('is_admin')
    .where('id', '=', authUser.userId)
    .executeTakeFirst()
  if (!user?.is_admin) {
    throw createError({ statusCode: 403, statusMessage: 'Operator admin required' })
  }
  return { userId: authUser.userId }
}

// OAuth flow helpers — bind the active org to the OAuth `state` so callbacks
// land in the correct org regardless of which tab the user comes back to.
// No-op in single mode.
export function encodeFlowOrg<S>(state: S): S {
  return state
}

export function decodeFlowOrg<S>(state: S): { state: S, orgSlug: string | null } {
  return { state, orgSlug: null }
}

export type OrgTransactionFn<T> = (tx: Transaction<Database>) => Promise<T>

// Caller-supplied org selection. Single mode has one tenant, so both fields
// are accepted for API compatibility with the multi-mode kernel and ignored.
export interface OrgTransactionOpts {
  org?: string
  userId?: string
}

// Open a transaction and run `fn(tx)` inside it. In single mode, just opens
// the transaction. In multi mode (overridden by the tenancy layer) this also
// resolves the org (`opts.org`, else the request's header or cookie),
// enforces the acting user's membership when `opts.userId` is given, and
// runs `SET LOCAL app.current_org` before yielding.
//
// Used by code paths that aren't routed through `defineTenantHandler` but
// still need to write to RLS-protected tables (the OAuth flow's non-`/api/`
// endpoints, which can't go through the tenancy middleware).
export async function runInOrgTransaction<T>(event: H3Event, fn: OrgTransactionFn<T>): Promise<T>
export async function runInOrgTransaction<T>(event: H3Event, opts: OrgTransactionOpts, fn: OrgTransactionFn<T>): Promise<T>
export async function runInOrgTransaction<T>(
  _event: H3Event,
  optsOrFn: OrgTransactionOpts | OrgTransactionFn<T>,
  maybeFn?: OrgTransactionFn<T>
): Promise<T> {
  const fn = (typeof optsOrFn === 'function' ? optsOrFn : maybeFn) as OrgTransactionFn<T>
  return await runTransaction(db, fn)
}

// Open a transaction scoped to the org that owns the given project. In single
// mode this is just `db.transaction()` — there is no org concept. In multi
// mode (overridden by the tenancy layer) the project's `org_id` is resolved
// via BYPASSRLS and `SET LOCAL app.current_org` is run before yielding.
//
// Used by the public feedback widget endpoints which receive a project_id
// from an unauthenticated cross-origin request and must operate in that
// project's tenant context.
export async function withProjectOrgContext<T>(
  _event: H3Event,
  _projectId: string,
  fn: (tx: Transaction<Database>) => Promise<T>
): Promise<T> {
  return await runTransaction(db, fn)
}

// Resolve the org that owns an arbitrary record and run `fn` in its context.
// In single mode this is just `db.transaction()` — there is no org concept, so
// the table/id/idColumn opts are ignored and `fn` queries the row itself. In
// multi mode (overridden by the tenancy layer) the record's `org_id` is
// resolved via BYPASSRLS and `SET LOCAL app.current_org` is run before
// yielding. Used by operator-admin endpoints and public token routes (e.g.
// the files layer's share-link reader) that must reach an RLS-protected row
// without an authenticated tenant request.
export async function withRecordOrgContext<T>(
  _event: H3Event,
  // `appId` is ignored here: single deploys have no per-org app switch.
  _opts: { table: string, id: string, idColumn?: string, notFoundMessage?: string, validateUuid?: boolean, appId?: string },
  fn: (tx: Transaction<Database>) => Promise<T>
): Promise<T> {
  return await runTransaction(db, fn)
}

// Membership check against the org bound to the current transaction (the GUC
// set by `withOrgContext` / `withRecordOrgContext`). Single mode has no orgs —
// every authenticated user belongs to the deployment — so this is always true.
// The tenancy layer overrides it with a real memberships lookup.
export async function isActiveOrgMember(
  _tx: Transaction<Database>,
  _userId: string
): Promise<boolean> {
  return true
}

// Whether `appId` is on for the org bound to the current transaction. Single
// deploys have no per-org app switch, so it always is. The tenancy layer
// overrides it with the org's app settings. For public routes that reach a
// second app (helpinator handing off into inbox) on top of the `appId` that
// `withRecordOrgContext` already checks.
export async function isAppEnabledForCurrentOrg(
  _tx: Transaction<Database>,
  _appId: string
): Promise<boolean> {
  return true
}

// Migration helper. In single mode this is a no-op — single deploys don't
// have an `orgs` table to reference and don't need RLS. Per-app tenancy
// migrations call this from inside `*_T<NNN>_*.ts` files; those files are
// only included by the migrator when the tenancy layer is loaded.
export async function enableTenantScoping(_db: unknown, _table: string): Promise<void> {
  // Intentional no-op. The tenancy layer overrides this with the real ALTER.
}

export async function disableTenantScoping(_db: unknown, _table: string): Promise<void> {
  // Intentional no-op.
}
