// Personal apps: app layers registered with `registerApp({ scope: 'user' })`.
// Their data belongs to each user rather than to an org, they look the same
// from every org, and they are turned on per user instead of per org. Works
// the same in single and multi mode — nothing here reads or sets the org GUC.
//
// Whether an app is on for a user (registry-first, see `defineSettings`):
//
//   1. Registry default   — `registerApp({ defaultStatus })`
//   2. Host-admin status  — `apps.status` (set via /admin/apps)
//        'default'                     on for every signed-in user
//        'available' / 'host_controlled'  on only with a grant (3)
//        'admins'                      on only for host admins
//        'disabled'                    off for everyone
//   3. Grants             — a `user_apps` row (set by a host admin, or by
//                           accepting an invite that carries the app), or
//                           membership of a host group listed in `app_groups`
//
// While an app is on for a user they hold every permission it lists in
// `registerApp({ permissions })`; personal apps take nothing from roles.
//
// Handlers run in a transaction with `app.current_user` set to the caller.
// Personal tables key their RLS policies on that setting:
//   user_id = nullif(current_setting('app.current_user', true), '')::uuid

import type { H3Event, EventHandler, EventHandlerRequest } from 'h3'
import { sql, type Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { Permission } from '#core/app/utils/permissions'
import { db } from './database'
import { runTransaction } from './after-commit'
import { requireAuth } from './auth'
import { defineSettings, type DbClient } from './settings'
import { getApps, type AppCatalogEntry } from './app-settings'
import { isRegisteredPermission } from './permissions-registry'

export interface UserAppEntry extends AppCatalogEntry {
  enabled: boolean
  // True when the user holds a `user_apps` grant for the app.
  granted: boolean
  // True when the user is in a host group that can open the app.
  viaGroup: boolean
}

interface UserAppRow {
  granted: boolean
  viaGroup: boolean
}

// What a user has that can turn a personal app on for them.
export interface UserAppAccess {
  granted: boolean
  viaGroup: boolean
  isAdmin: boolean
}

const readUserApps = defineSettings<AppCatalogEntry, UserAppRow, Omit<UserAppEntry, 'enabled'>>({
  loadDefaults: async (tx) => {
    const catalog = await getApps(tx)
    return catalog.filter(a => a.installed && a.scope === 'user')
  },
  loadOverrides: async (tx, ctx) => {
    if (!ctx.userId) throw new Error('getUserApps requires ctx.userId')
    const [grants, viaGroups] = await Promise.all([
      tx.selectFrom('user_apps').select('app_id').where('user_id', '=', ctx.userId).execute(),
      tx.selectFrom('app_groups')
        .innerJoin('groups', 'groups.id', 'app_groups.group_id')
        .innerJoin('group_members', 'group_members.group_id', 'app_groups.group_id')
        .select('app_groups.app_id')
        .distinct()
        .where('group_members.user_id', '=', ctx.userId)
        .where('groups.org_id', 'is', null)
        .execute()
    ])
    const out = new Map<string, UserAppRow>()
    for (const r of grants) out.set(r.app_id, { granted: true, viaGroup: false })
    for (const r of viaGroups) out.set(r.app_id, { granted: out.get(r.app_id)?.granted ?? false, viaGroup: true })
    return out
  },
  keyOf: app => app.id,
  merge: (app, row) => ({
    ...app!,
    granted: row?.granted ?? false,
    viaGroup: row?.viaGroup ?? false
  })
})

export async function getUserApps(client: DbClient, ctx: { userId: string }): Promise<UserAppEntry[]> {
  const [apps, user] = await Promise.all([
    readUserApps(client, ctx),
    client.selectFrom('users').select('is_admin').where('id', '=', ctx.userId).executeTakeFirst()
  ])
  const isAdmin = user?.is_admin === true
  return apps.map(a => ({ ...a, enabled: resolveUserAppEnabled(a.status, { granted: a.granted, viaGroup: a.viaGroup, isAdmin }) }))
}

export function resolveUserAppEnabled(status: AppCatalogEntry['status'], access: UserAppAccess): boolean {
  if (status === 'disabled') return false
  if (status === 'default') return true
  if (status === 'admins') return access.isAdmin
  return access.granted || access.viaGroup
}

export async function getUserEnabledApps(client: DbClient, userId: string): Promise<UserAppEntry[]> {
  return (await getUserApps(client, { userId })).filter(a => a.enabled)
}

export async function isPersonalAppEnabledForUser(client: DbClient, userId: string, appId: string): Promise<boolean> {
  return (await getUserEnabledApps(client, userId)).some(a => a.id === appId)
}

// Every permission the user holds through the personal apps that are on for
// them. The tenant kernels union this into the across-orgs and per-request
// sets, so OAuth consent, bearer scopes and MCP see personal-app permissions.
export async function getPersonalAppPermissions(client: DbClient, userId: string): Promise<Set<Permission>> {
  return permissionsOfApps(await getUserEnabledApps(client, userId))
}

// The permissions a set of enabled personal apps grants.
export function permissionsOfApps(apps: UserAppEntry[]): Set<Permission> {
  const perms = new Set<Permission>()
  for (const app of apps) {
    for (const p of app.permissions) {
      if (isRegisteredPermission(p)) perms.add(p as Permission)
    }
  }
  return perms
}

// Turns a personal app on (or off) for one user. A no-op when nothing changes.
export async function setUserAppGrant(
  client: DbClient,
  input: { userId: string, appId: string, granted: boolean, grantedBy: string | null }
): Promise<void> {
  if (!input.granted) {
    await client.deleteFrom('user_apps').where('user_id', '=', input.userId).where('app_id', '=', input.appId).execute()
    return
  }
  // The catalog row is normally seeded on first request; make sure the FK holds.
  await client.insertInto('apps').values({ id: input.appId }).onConflict(oc => oc.column('id').doNothing()).execute()
  await client
    .insertInto('user_apps')
    .values({ user_id: input.userId, app_id: input.appId, granted_by: input.grantedBy })
    .onConflict(oc => oc.constraint('user_apps_user_app_key').doNothing())
    .execute()
}

export interface UserContext {
  userId: string
  // Permissions from the personal apps that are on for the user.
  perms: Set<Permission>
}

export interface UserHandlerOpts {
  appId: string
}

export type UserHandler<T> = (tx: Transaction<Database>, ctx: UserContext) => Promise<T> | T

// Opens a transaction for `userId` in a personal app: 410 when the app isn't
// on for them, `app.current_user` set before `fn` runs. For callers that
// authenticate some other way than the session cookie (an OAuth bearer token,
// a background job), which pass the user id they already resolved.
export async function runInUserTransaction<T>(
  userId: string,
  opts: UserHandlerOpts,
  fn: UserHandler<T>
): Promise<T> {
  return await runTransaction(db, async (tx) => {
    const enabled = await getUserEnabledApps(tx, userId)
    if (!enabled.some(a => a.id === opts.appId)) {
      throw createError({ statusCode: 410, statusMessage: `App "${opts.appId}" is not enabled for you.` })
    }
    await sql`select set_config('app.current_user', ${userId}, true)`.execute(tx)
    return await fn(tx, { userId, perms: permissionsOfApps(enabled) })
  })
}

// Session-authenticated personal-app handler body. Ignores any org the
// request names: personal apps are the same in every org.
export async function withUserContext<T>(event: H3Event, opts: UserHandlerOpts, fn: UserHandler<T>): Promise<T> {
  const authUser = requireAuth(event)
  return await runInUserTransaction(authUser.userId, opts, fn)
}

// Same as `withUserContext` plus a permission gate on `ctx.perms`.
export async function withUserPermission<T>(
  event: H3Event,
  opts: UserHandlerOpts,
  perm: Permission,
  fn: UserHandler<T>
): Promise<T> {
  return await withUserContext(event, opts, async (tx, ctx) => {
    if (!ctx.perms.has(perm)) {
      throw createError({ statusCode: 403, statusMessage: `Permission required: ${perm}` })
    }
    return await fn(tx, ctx)
  })
}

export function defineUserHandler<T>(opts: UserHandlerOpts, fn: UserHandler<T>): EventHandler<EventHandlerRequest, Promise<T>> {
  return defineEventHandler<EventHandlerRequest, Promise<T>>(event => withUserContext(event, opts, fn))
}
