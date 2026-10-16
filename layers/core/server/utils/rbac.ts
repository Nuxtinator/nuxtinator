import type { H3Event } from 'h3'
import type { Kysely, Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import { db } from './database'
import { requireAuth } from './auth'
import {
  STATIC_ROLE_NAMES,
  isStaticRole,
  getStaticRole
} from '#core/app/utils/role-definitions'
import type { Permission } from '#core/app/utils/permissions'
import { getAppStaticRole, getAppStaticRoleNames } from './roles-registry'
import { getAllPermissions, isRegisteredPermission } from './permissions-registry'
import { getDefaultGrants } from './default-grants-registry'
import { getRoleOverlay } from './role-overlay-registry'

type DbClient = Kysely<Database> | Transaction<Database>

// Resolves a list of role names to the union of permissions they grant.
//
// Each role's set is built from:
//   1. Host static roles (`role-definitions.ts`) — empty by default.
//   2. App-static roles (the runtime roles-registry).
//   3. Custom roles (`custom_roles` DB).
//   4. Default grants from layers (`default-grants-registry`).
// With an `orgId`, the registered role overlay (`role-overlay-registry`) then
// adjusts each role's set for that org — the tenancy layer applies its
// per-org `org_role_overrides` there — before the sets are unioned. In multi
// mode RLS also scopes `custom_roles` to the active org.
//
// `admin` is special-cased to the union of every registered permission so
// layer-contributed perms automatically reach admin without explicit grants.
export async function getRolePermissions(
  client: DbClient,
  roleNames: readonly string[],
  orgId: string | null
): Promise<Set<Permission>> {
  if (roleNames.length === 0) return new Set()

  const perRole = new Map<string, Set<string>>()
  const customNames: string[] = []

  for (const roleName of roleNames) {
    if (roleName === 'admin') continue

    const staticRole = getStaticRole(roleName) ?? getAppStaticRole(roleName)
    if (staticRole) {
      perRole.set(roleName, new Set(staticRole.permissions))
      continue
    }

    customNames.push(roleName)
  }

  if (customNames.length > 0) {
    // RLS scopes `custom_roles` to the active org in multi mode (when run
    // inside a transaction with `app.current_org` set). In single mode the
    // table is global. Same query, both modes.
    const customRows = await client
      .selectFrom('custom_roles')
      .select(['name', 'permissions'])
      .where('name', 'in', customNames)
      .execute()
    for (const row of customRows) {
      const perms = perRole.get(row.name) ?? new Set<string>()
      for (const perm of row.permissions) {
        if (isRegisteredPermission(perm)) perms.add(perm)
      }
      perRole.set(row.name, perms)
    }
  }

  for (const roleName of roleNames) {
    if (!isStaticRole(roleName) || roleName === 'admin') continue
    const perms = perRole.get(roleName) ?? new Set<string>()
    for (const perm of getDefaultGrants(roleName)) perms.add(perm)
    perRole.set(roleName, perms)
  }

  const overlay = getRoleOverlay()
  if (orgId && overlay) await overlay(orgId, perRole)

  const set = new Set<string>()
  if (roleNames.includes('admin')) {
    for (const perm of getAllPermissions()) set.add(perm)
  }
  for (const perms of perRole.values()) {
    for (const perm of perms) set.add(perm)
  }
  return set as Set<Permission>
}

// Validates role names against the static + custom set. Custom-role lookup is
// scoped by RLS in multi mode; in single mode the table is global so the
// query returns all matches.
export async function validateRoleNames(
  client: DbClient,
  roles: string[]
): Promise<{ valid: boolean, unknown: string[] }> {
  const known = new Set<string>(['admin', ...STATIC_ROLE_NAMES])
  for (const k of getAppStaticRoleNames()) known.add(k)
  const unknownAfterStatic = roles.filter(r => !known.has(r))
  if (unknownAfterStatic.length === 0) {
    return { valid: true, unknown: [] }
  }

  const customRows = await client
    .selectFrom('custom_roles')
    .select('name')
    .where('name', 'in', unknownAfterStatic)
    .execute()
  const customKnown = new Set(customRows.map(r => r.name))
  const unknown = unknownAfterStatic.filter(r => !customKnown.has(r))
  return { valid: unknown.length === 0, unknown }
}

// `getUserPermissions(userId)` — the host-level permission set for a user
// outside any request context: the union of `users.roles[]` permissions, plus
// every registered permission when `is_admin` is set. Org memberships and
// per-user grants are not included; the `#tenant/server` kernel's
// `getUserPermissionsAcrossOrgs` / `getUserPermissionsForRequest` layer those
// on top and are what the OAuth scope filters and MCP gates read.
export async function getUserPermissions(userId: string): Promise<Set<Permission>> {
  const user = await db
    .selectFrom('users')
    .select(['is_admin', 'roles'])
    .where('id', '=', userId)
    .executeTakeFirst()
  if (!user) return new Set()
  const roles = [...user.roles]
  if (user.is_admin) roles.push('admin')
  return await getRolePermissions(db, roles, null)
}

// `requirePermission(event, perm)` — authenticate + check that the user
// holds the named permission. The OAuth/MCP blueprint layers call this on
// their admin routes. In multi mode the tenancy layer can patch the impl
// to enforce per-org context; here it's the single-mode global check.
export async function requirePermission(
  event: H3Event,
  permission: Permission | string
): Promise<{ userId: string }> {
  const authUser = requireAuth(event)
  const perms = await getUserPermissions(authUser.userId)
  if (!perms.has(permission as Permission)) {
    throw createError({ statusCode: 403, statusMessage: `Permission required: ${permission}` })
  }
  return { userId: authUser.userId }
}

export { STATIC_ROLE_NAMES }
