// Multi-mode `#tenant/server` kernel. Overrides the host's single-mode kernel
// via the alias module in `optional-tenancy/modules/tenant-kernel.ts`.
//
// Pipeline for `defineTenantHandler({ appId })`:
//   1. `requireAuth(event)` — JWT cookie → user identity.
//   2. Read `event.context.orgSlug` / `event.context.orgId` set by the tenancy
//      Nitro middleware (which validated the user's membership in this org).
//      404 if absent — caller didn't go through the middleware.
//   3. Open a Kysely transaction on `db` and `SET LOCAL app.current_org`
//      INSIDE that transaction. This is the only place the GUC gets set —
//      middleware doesn't because `SET LOCAL` is transaction-scoped and
//      pooled connections (PgBouncer txn-pool) wouldn't carry it forward.
//   4. Compute the user's effective permission set for this org —
//      union(membership role perms) ∪ direct grants (`user_permission_grants`,
//      org-scoped by RLS since the read runs after the GUC is set).
//   5. If `opts.appId` was passed, 410 if that app is disabled for the org.
//   6. Refresh the `active-org-slug` cookie (30d) so bare-URL hits redirect.
//   7. Run the handler with `(tx, ctx)` where ctx has full org context.
import type { H3Event, EventHandler, EventHandlerRequest } from 'h3'
import type { Transaction, Kysely } from 'kysely'
import { sql } from 'kysely'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { db } from '#core/server/utils/database'
// Tracks each request transaction so `afterCommit` work runs once it commits.
import { runTransaction } from '#core/server/utils/after-commit'
import { requireAuth } from '#core/server/utils/auth'
import { getRolePermissions, getUserPermissions } from '#core/server/utils/rbac'
import { getUserGrantedPermissions } from '#core/server/utils/permission-grants'
import { getPersonalAppPermissions } from '#core/server/utils/personal-apps'
import type { Database } from '#core/server/database/schema'
import type { Permission } from '#core/app/utils/permissions'

// App-enable resolution is registry-first — see `./app-settings.ts` for
// the three-tier merge. Imported here for use inside `defineTenantHandler`'s
// `appId` opt; external callers import the helpers directly from
// `./app-settings.ts` so Nitro auto-import doesn't see two copies.
import { isAppEnabledForOrg } from './app-settings'
import { adminDb } from './database-admin'

export interface TenantContext {
  userId: string
  orgId: string
  orgSlug: string
  orgName: string
  // `role` is the first membership role (display shorthand); `roles` is the
  // user's full membership role list for this org.
  role: string | null
  roles: string[]
  // Effective permissions for this org: union(role perms) ∪ direct user
  // grants (org-scoped via RLS).
  perms: Set<Permission>
}

export interface DefineTenantHandlerOpts {
  appId?: string
}

export type TenantHandler<T> = (
  tx: Transaction<Database>,
  ctx: TenantContext
) => Promise<T> | T

// The shared core: validates middleware-supplied context, opens the txn, sets
// the GUC, and yields. Used by both `defineTenantHandler` (returns an
// EventHandler) and `withOrgContext` (function-call style, used inside an
// existing defineEventHandler).
async function runWithOrgContext<T>(
  event: H3Event,
  opts: DefineTenantHandlerOpts,
  fn: TenantHandler<T>
): Promise<T> {
  const authUser = requireAuth(event)
  const orgSlug = event.context.orgSlug as string | undefined
  const orgId = event.context.orgId as string | undefined
  const orgName = (event.context.orgName as string | undefined) ?? ''
  const memberRoles = (event.context.orgRoles as string[] | undefined) ?? []

  if (!orgSlug || !orgId) {
    throw createError({
      statusCode: 404,
      statusMessage: 'This organization does not exist or you don\'t have access.'
    })
  }

  return await runTransaction(db, async (tx) => {
    await sql`select set_config('app.current_org', ${orgId}, true)`.execute(tx)

    const perms = await getRolePermissions(tx, memberRoles, orgId)
    // Additive per-user grants ride on top of role-derived perms. The read
    // runs inside this transaction — after the GUC is set — so RLS scopes
    // the grants to the active org without an explicit org_id filter.
    for (const perm of await getUserGrantedPermissions(tx, authUser.userId)) {
      perms.add(perm)
    }

    if (opts.appId) {
      const ok = await isAppEnabledForOrg(tx, orgId, opts.appId)
      if (!ok) {
        throw createError({
          statusCode: 410,
          statusMessage: `App "${opts.appId}" is not enabled for this organization.`
        })
      }
    }

    setCookie(event, 'active-org-slug', orgSlug, {
      maxAge: 60 * 60 * 24 * 30,
      sameSite: 'lax',
      path: '/',
      httpOnly: false
    })

    const role = memberRoles[0] ?? null
    return await fn(tx, {
      userId: authUser.userId,
      orgId,
      orgSlug,
      orgName,
      role,
      roles: memberRoles,
      perms
    })
  })
}

export function defineTenantHandler<T>(fn: TenantHandler<T>): EventHandler<EventHandlerRequest, Promise<T>>
export function defineTenantHandler<T>(opts: DefineTenantHandlerOpts, fn: TenantHandler<T>): EventHandler<EventHandlerRequest, Promise<T>>
export function defineTenantHandler<T>(
  optsOrFn: DefineTenantHandlerOpts | TenantHandler<T>,
  maybeFn?: TenantHandler<T>
): EventHandler<EventHandlerRequest, Promise<T>> {
  const opts: DefineTenantHandlerOpts = typeof optsOrFn === 'function' ? {} : optsOrFn
  const fn = (typeof optsOrFn === 'function' ? optsOrFn : maybeFn) as TenantHandler<T>
  return defineEventHandler<EventHandlerRequest, Promise<T>>(event => runWithOrgContext(event, opts, fn))
}

// Function-call style — for handlers already wrapped in `defineEventHandler`.
// Same semantics as `defineTenantHandler`, called from inside an existing
// handler body.
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
  const opts: DefineTenantHandlerOpts = typeof optsOrFn === 'function' ? {} : optsOrFn
  const fn = (typeof optsOrFn === 'function' ? optsOrFn : maybeFn) as TenantHandler<T>
  return runWithOrgContext(event, opts, fn)
}

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
  const opts: DefineTenantHandlerOpts = hasOpts ? (a as DefineTenantHandlerOpts) : {}
  const perm = (hasOpts ? b : a) as Permission
  const fn = (hasOpts ? c : b) as TenantHandler<T>
  return runWithOrgContext(event, opts, async (tx, ctx) => {
    if (!ctx.perms.has(perm)) {
      throw createError({ statusCode: 403, statusMessage: `Permission required: ${perm}` })
    }
    return await fn(tx, ctx)
  })
}

// Compute the effective permission set for a (user, org) pair. Used by
// admin/membership endpoints that need to display a user's permissions in
// an org without going through the request's own context. Looks up the
// user's membership roles, then resolves them through the per-org overlay.
export async function computePermsForOrg(
  client: Kysely<Database> | Transaction<Database>,
  userId: string,
  orgId: string
): Promise<Set<Permission>> {
  const membership = await client
    .selectFrom('memberships')
    .select('roles')
    .where('user_id', '=', userId)
    .where('org_id', '=', orgId)
    .executeTakeFirst()
  if (!membership) return new Set()
  return await getRolePermissions(client, membership.roles, orgId)
}

// Per-org effective permissions for a (user, org) pair, read the way
// `runWithOrgContext` reads them: inside a transaction with the GUC set, so
// `custom_roles` and `user_permission_grants` are RLS-scoped to that org.
async function resolveOrgPerms(userId: string, orgId: string): Promise<Set<Permission>> {
  return await runTransaction(db, async (tx) => {
    await sql`select set_config('app.current_org', ${orgId}, true)`.execute(tx)
    const perms = await computePermsForOrg(tx, userId, orgId)
    for (const perm of await getUserGrantedPermissions(tx, userId)) {
      perms.add(perm)
    }
    return perms
  })
}

// Every permission the user holds anywhere: the host-level set (`users.roles`
// plus everything when `is_admin`) unioned with the effective set of each org
// they belong to (suspended orgs excluded) and with their personal apps'
// permissions. The OAuth layer uses it as the
// upper bound for consent and token issuance — tokens are not org-bound, the
// org is chosen per call — and the MCP layer uses it for tools/list visibility.
export async function getUserPermissionsAcrossOrgs(userId: string): Promise<Set<Permission>> {
  const perms = await getUserPermissions(userId)
  const memberships = await adminDb
    .selectFrom('memberships')
    .innerJoin('orgs', 'orgs.id', 'memberships.org_id')
    .select('memberships.org_id')
    .where('memberships.user_id', '=', userId)
    .where('orgs.suspended_at', 'is', null)
    .execute()
  for (const m of memberships) {
    for (const perm of await resolveOrgPerms(userId, m.org_id)) perms.add(perm)
  }
  for (const perm of await getPersonalAppPermissions(db, userId)) perms.add(perm)
  return perms
}

// The user's effective permissions for the org a request targets. Org
// discovery follows `runInOrgTransaction`: `opts.org`, then the middleware's
// `event.context`, then the `X-Active-Org` header, then the `active-org-slug`
// cookie — with the same membership and suspension checks (404 / 423). A
// request that selects no org gets the across-orgs set, which is what
// org-less surfaces (a tool that lists the user's orgs) need.
export async function getUserPermissionsForRequest(
  event: H3Event,
  userId: string,
  opts: { org?: string } = {}
): Promise<Set<Permission>> {
  let orgId: string | undefined
  let slug: string | undefined
  if (opts.org) {
    slug = opts.org
  } else {
    orgId = event.context.orgId as string | undefined
    if (!orgId) {
      slug = (event.context.orgSlug as string | undefined)
        ?? getRequestHeader(event, 'x-active-org')
        ?? getCookie(event, 'active-org-slug')
    }
  }
  if (!orgId && slug) {
    orgId = await resolveSelectedOrg(slug, userId)
  }
  if (!orgId) return await getUserPermissionsAcrossOrgs(userId)

  const perms = await getUserPermissions(userId)
  for (const perm of await resolveOrgPerms(userId, orgId)) perms.add(perm)
  // Personal apps are the same in every org.
  for (const perm of await getPersonalAppPermissions(db, userId)) perms.add(perm)
  return perms
}

// Operator-admin gate. The bit (`users.is_admin`) lives in core; this is the
// same check, re-exported from the multi-mode kernel for symmetry. The thing
// the tenancy layer adds *on top* is BYPASSRLS DB-role plumbing
// (`adminDb` in `database-admin.ts`) for cross-org reach.
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

// Legacy alias — the host previously used the term "host admin" for this.
// Same semantics. Kept for backward compatibility with already-moved code.
export const requireHostAdmin = requireOperatorAdmin

// OAuth flow helpers. Bind the active org to the OAuth `state` so callbacks
// land in the correct org regardless of which tab the user comes back to.
function flowSecret(): string {
  const s = useRuntimeConfig().tenantFlowSecret
  if (!s) throw new Error('NUXT_TENANT_FLOW_SECRET is not set')
  return s
}

export function encodeFlowOrg<S extends string>(state: S, orgSlug: string | null): string {
  if (!orgSlug) return state
  const payload = `${state}|${orgSlug}`
  const sig = createHmac('sha256', flowSecret()).update(payload).digest('base64url')
  return `${payload}|${sig}`
}

export function decodeFlowOrg(combined: string): { state: string, orgSlug: string | null } {
  const parts = combined.split('|')
  if (parts.length !== 3) return { state: combined, orgSlug: null }
  const [state, slug, sig] = parts as [string, string, string]
  const expected = createHmac('sha256', flowSecret()).update(`${state}|${slug}`).digest()
  const actual = Buffer.from(sig, 'base64url')
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { state: combined, orgSlug: null }
  }
  return { state, orgSlug: slug }
}

export type OrgTransactionFn<T> = (tx: Transaction<Database>) => Promise<T>

// Caller-supplied org selection for `runInOrgTransaction`. `org` is a slug
// taken from the request body (MCP tools expose it as an `org` input) and
// requires `userId`; `userId` alone turns on membership enforcement for
// whichever client-controlled source the org came from.
export interface OrgTransactionOpts {
  org?: string
  userId?: string
}

const ORG_NOT_FOUND = 'This organization does not exist or you don\'t have access.'

// Resolves a client-selected slug to an org id. Without `userId` an unknown
// slug yields undefined. With `userId`, the org must exist, must not be
// suspended, and the user must hold a membership; a missing org and a
// missing membership collapse into the same 404 the tenancy middleware
// returns so a probe can't tell them apart.
async function resolveSelectedOrg(slug: string, userId?: string): Promise<string | undefined> {
  if (!userId) {
    const row = await adminDb
      .selectFrom('orgs')
      .select('id')
      .where('slug', '=', slug)
      .executeTakeFirst()
    return row?.id
  }
  const row = await adminDb
    .selectFrom('orgs')
    .innerJoin('memberships', 'memberships.org_id', 'orgs.id')
    .select(['orgs.id', 'orgs.suspended_at'])
    .where('orgs.slug', '=', slug)
    .where('memberships.user_id', '=', userId)
    .executeTakeFirst()
  if (!row) throw createError({ statusCode: 404, statusMessage: ORG_NOT_FOUND })
  if (row.suspended_at) throw createError({ statusCode: 423, statusMessage: 'This organization is suspended.' })
  return row.id
}

// Org ids the user actively belongs to. Backs the fallback for surfaces that
// carry no org selector at all; only the single-membership case uses it, so
// the order is immaterial.
async function memberOrgIds(userId: string): Promise<string[]> {
  const rows = await adminDb
    .selectFrom('memberships')
    .innerJoin('orgs', 'orgs.id', 'memberships.org_id')
    .select('orgs.id')
    .where('memberships.user_id', '=', userId)
    .where('orgs.suspended_at', 'is', null)
    .execute()
  return rows.map(r => r.id)
}

// Open a transaction and run `fn(tx)` inside it with the active org's GUC set.
// Used by code paths that aren't routed through `defineTenantHandler` but
// still need to write to RLS-protected tables: the OAuth flow's non-`/api/`
// endpoints, which can't go through the tenancy middleware, and MCP tool
// handlers, which authenticate with a bearer token instead of a session.
//
// Org discovery (in priority order):
//   1. `opts.org` — a slug from the caller's own input
//   2. `event.context.orgId` / `orgSlug` set by upstream middleware, which has
//      already verified the session user's membership
//   3. `X-Active-Org` header — bearer-authenticated requests carry the header
//      but no session cookie, so the tenancy middleware never populates
//      `event.context` for them
//   4. `active-org-slug` cookie
//   5. the user's sole active membership, when `opts.userId` is given and
//      nothing above selected an org
// Sources 1, 3 and 4 are client-controlled: they select the org, they do not
// authorize. Callers that know the acting user pass `opts.userId`, which
// makes any client-selected org subject to a membership check (see
// `resolveSelectedOrg`), enables source 5, and turns a user with several
// orgs and no selection into a 400. Without `opts.userId` an unknown or
// missing slug opens the txn with no GUC — RLS-protected INSERTs then fail
// loudly via `current_org_id() → NULL`.
export async function runInOrgTransaction<T>(event: H3Event, fn: OrgTransactionFn<T>): Promise<T>
export async function runInOrgTransaction<T>(event: H3Event, opts: OrgTransactionOpts, fn: OrgTransactionFn<T>): Promise<T>
export async function runInOrgTransaction<T>(
  event: H3Event,
  optsOrFn: OrgTransactionOpts | OrgTransactionFn<T>,
  maybeFn?: OrgTransactionFn<T>
): Promise<T> {
  const opts: OrgTransactionOpts = typeof optsOrFn === 'function' ? {} : optsOrFn
  const fn = (typeof optsOrFn === 'function' ? optsOrFn : maybeFn) as OrgTransactionFn<T>
  if (opts.org && !opts.userId) {
    throw new Error('runInOrgTransaction: `org` requires `userId` so membership can be enforced')
  }

  let orgId: string | undefined
  let slug: string | undefined
  if (opts.org) {
    slug = opts.org
  } else {
    orgId = event.context.orgId as string | undefined
    if (!orgId) {
      slug = (event.context.orgSlug as string | undefined)
        ?? getRequestHeader(event, 'x-active-org')
        ?? getCookie(event, 'active-org-slug')
    }
  }
  if (!orgId && slug) {
    orgId = opts.org
      // An explicit `org` is the caller's own selection — a slug that names
      // no accessible org is a caller error and surfaces as 404 / 423.
      ? await resolveSelectedOrg(slug, opts.userId)
      // Header and cookie slugs are ambient request state that can be stale
      // (org renamed, membership removed, cookie from another deployment).
      // A miss falls through to the membership fallback instead of failing.
      : await resolveSelectedOrg(slug, opts.userId).catch(() => undefined)
  }
  // Nothing selected an org. Surfaces that can't carry a selector land here:
  // the OAuth consent flow runs on non-`/api/` paths the tenancy middleware
  // never populates, and a browser navigation sends no `X-Active-Org`. With a
  // single membership the org is unambiguous, so resolve it rather than
  // opening a GUC-less transaction whose RLS-protected writes would fail.
  if (!orgId && opts.userId) {
    const owned = await memberOrgIds(opts.userId)
    if (owned.length === 1) orgId = owned[0]
  }
  if (!orgId && opts.userId) {
    throw createError({ statusCode: 400, statusMessage: 'No organization selected. Pass `org` or send the X-Active-Org header.' })
  }

  return await runTransaction(db, async (tx) => {
    if (orgId) {
      await sql`select set_config('app.current_org', ${orgId}, true)`.execute(tx)
    }
    return await fn(tx)
  })
}

// Open a transaction scoped to the org that owns the given project. Used by
// public widget endpoints (notably /api/v1/feedback*) that receive a
// project_id from an unauthenticated cross-origin request and must operate
// in that project's tenant context.
//
// Resolves `projects.org_id` via BYPASSRLS (`adminDb`) since RLS would
// otherwise block the lookup, then opens a Kysely transaction on the regular
// `db` and `SET LOCAL app.current_org` inside that transaction.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function withProjectOrgContext<T>(
  _event: H3Event,
  projectId: string,
  fn: (tx: Transaction<Database>) => Promise<T>
): Promise<T> {
  if (!UUID_RE.test(projectId)) {
    throw createError({ statusCode: 404, statusMessage: 'Project not found' })
  }
  // Raw SQL — `org_id` is added dynamically to `projects` by the feedback
  // layer's `feedback_T010_enable_tenancy.ts` migration but isn't part of
  // the layer's Kysely schema definition.
  const result = await sql<{ org_id: string }>`
    select org_id from projects where id = ${projectId}
  `.execute(adminDb)
  const orgId = result.rows[0]?.org_id
  if (!orgId) {
    throw createError({ statusCode: 404, statusMessage: 'Project not found' })
  }
  return await runTransaction(db, async (tx) => {
    await sql`select set_config('app.current_org', ${orgId}, true)`.execute(tx)
    return await fn(tx)
  })
}

// Operator-admin variant of `withProjectOrgContext`: looks up the org_id of an
// arbitrary RLS-protected record via adminDb (BYPASSRLS), opens a db
// transaction, sets `app.current_org` from that org, then runs the handler.
//
// Used by app-level operator-admin endpoints that need to triage a record by
// its primary key without knowing which org owns it — for example,
// `PATCH /api/admin/feedback/:id` on the feedback layer. App layers can't
// import `#tenant/admin-db` directly (tenancy contract), so this helper is
// the sanctioned path.
//
// The caller passes the table name + id; the helper interpolates the table
// name via `sql.ref()` to prevent SQL injection. The id is matched as a bound
// parameter, so non-UUID keys are injection-safe too. By default the id must
// be UUID-shaped — a guard against feeding a malformed value into a uuid-typed
// key column (which would surface as a 22P02 cast error). Callers keying on a
// text column (e.g. a hex share token) pass `validateUuid: false`.
//
// Throws 404 with `notFoundMessage` if the record doesn't exist.
export async function withRecordOrgContext<T>(
  _event: H3Event,
  opts: {
    table: string
    id: string
    idColumn?: string
    notFoundMessage?: string
    validateUuid?: boolean
    // Public routes serving an app's records: refuse when the owning org is
    // suspended or has the app disabled, as `defineTenantHandler` does.
    appId?: string
  },
  fn: (tx: Transaction<Database>) => Promise<T>
): Promise<T> {
  const { table, id } = opts
  const idColumn = opts.idColumn ?? 'id'
  const notFoundMessage = opts.notFoundMessage ?? 'Not found'
  const validateUuid = opts.validateUuid ?? true

  if (validateUuid && !UUID_RE.test(id)) {
    throw createError({ statusCode: 404, statusMessage: notFoundMessage })
  }

  const result = await sql<{ org_id: string }>`
    select org_id from ${sql.ref(table)} where ${sql.ref(idColumn)} = ${id}
  `.execute(adminDb)
  const orgId = result.rows[0]?.org_id
  if (!orgId) {
    throw createError({ statusCode: 404, statusMessage: notFoundMessage })
  }
  if (opts.appId) {
    const org = await adminDb.selectFrom('orgs').select('suspended_at').where('id', '=', orgId).executeTakeFirst()
    if (!org || org.suspended_at) {
      throw createError({ statusCode: 423, statusMessage: 'This organization is suspended.' })
    }
  }

  return await runTransaction(db, async (tx) => {
    await sql`select set_config('app.current_org', ${orgId}, true)`.execute(tx)
    if (opts.appId && !(await isAppEnabledForOrg(tx, orgId, opts.appId))) {
      throw createError({ statusCode: 410, statusMessage: `App "${opts.appId}" is not enabled for this organization.` })
    }
    return await fn(tx)
  })
}

// Check whether `userId` is a member of the org bound to the current
// transaction (the `app.current_org` GUC set by `withOrgContext` /
// `withRecordOrgContext`). Lets token-resolved routes (e.g. the videos share
// endpoint) grant org-visibility access without the caller knowing the org id.
// False when no GUC is set. `memberships` carries no RLS, so the regular DB
// role can read it.
export async function isActiveOrgMember(
  tx: Transaction<Database>,
  userId: string
): Promise<boolean> {
  const result = await sql<{ org_id: string | null }>`
    select nullif(current_setting('app.current_org', true), '')::uuid as org_id
  `.execute(tx)
  const orgId = result.rows[0]?.org_id
  if (!orgId) return false
  const membership = await tx
    .selectFrom('memberships')
    .select('user_id')
    .where('org_id', '=', orgId)
    .where('user_id', '=', userId)
    .executeTakeFirst()
  return !!membership
}

// Whether `appId` is enabled for the org bound to the current transaction (the
// `app.current_org` GUC). False when no GUC is set. For public routes that
// reach a second app on top of the `appId` `withRecordOrgContext` checks.
export async function isAppEnabledForCurrentOrg(
  tx: Transaction<Database>,
  appId: string
): Promise<boolean> {
  const result = await sql<{ org_id: string | null }>`
    select nullif(current_setting('app.current_org', true), '')::uuid as org_id
  `.execute(tx)
  const orgId = result.rows[0]?.org_id
  if (!orgId) return false
  return await isAppEnabledForOrg(tx, orgId, appId)
}

// Schema-retrofit helper for app layer migrations. Per-app tenancy migrations
// live at `<layer>/migrations/<appId>_T<NNN>_*.ts` and call this. The tenancy
// layer's migration discovery module includes those files only when the
// tenancy layer is loaded; in single mode they don't run.
export async function enableTenantScoping(
  db: Kysely<unknown>,
  table: string
): Promise<void> {
  await sql`
    ALTER TABLE ${sql.ref(table)}
      ADD COLUMN org_id uuid NOT NULL DEFAULT current_org_id()
        REFERENCES orgs(id) ON DELETE CASCADE
  `.execute(db)
  await sql`ALTER TABLE ${sql.ref(table)} ENABLE ROW LEVEL SECURITY`.execute(db)
  await sql`
    CREATE POLICY tenant_isolation ON ${sql.ref(table)} FOR ALL
      USING       (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
      WITH CHECK  (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  `.execute(db)
}

export async function disableTenantScoping(
  db: Kysely<unknown>,
  table: string
): Promise<void> {
  await sql`DROP POLICY IF EXISTS tenant_isolation ON ${sql.ref(table)}`.execute(db)
  await sql`ALTER TABLE ${sql.ref(table)} DISABLE ROW LEVEL SECURITY`.execute(db)
  await sql`ALTER TABLE ${sql.ref(table)} DROP COLUMN org_id`.execute(db)
}
