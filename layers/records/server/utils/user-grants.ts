// Per-user crm.* grant administration — thin wrappers over core's
// permission-grants services with this surface's rules: only crm.*-prefixed
// slugs are listed or writable (this is the records settings surface, not a
// general grants admin), and the target must be a real user — an active-org
// member in multi mode, same membership rule as the user directory
// (routes/api/records/users.get.ts) and share targets. Grants are slug-level and
// additive: they pass through the type evaluator untouched, so a role-keyed
// per-type deny can never subtract them.

import type { Transaction } from 'kysely'
import { z } from 'zod'
import type { Database } from '#core/server/database/schema'
import type { TenantContext } from '#tenant/server'
import { listUserPermissionGrants } from '#core/server/utils/permission-grants'
import { isRegisteredPermission, getPermissionMeta } from '#core/server/utils/permissions-registry'
import { getRegisteredRecordTypes } from './records-registry'

type Tx = Transaction<Database>

export interface RecordsUserGrantEntry {
  permission: string
  title: string
  /** True when the slug is no longer registered (its layer is gone). Orphan
   * grants stop granting but stay listed so they can be revoked. */
  orphan: boolean
  grantedBy: string | null
  createdAt: Date
}

const uuidSchema = z.string().uuid()

// uuid columns reject malformed parameters with a SQL error, so validate up
// front and 400 instead.
export async function requireGrantTarget(
  tx: Tx,
  ctx: TenantContext,
  userId: string
): Promise<void> {
  if (!uuidSchema.safeParse(userId).success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid user id.' })
  }
  let qb = tx
    .selectFrom('users')
    .select('users.id')
    .where('users.id', '=', userId)
  if (ctx.orgId) {
    const orgId = ctx.orgId
    qb = qb.where(eb => eb.exists(
      eb.selectFrom('memberships')
        .select('memberships.user_id')
        .whereRef('memberships.user_id', '=', 'users.id')
        .where('memberships.org_id', '=', orgId)
    ))
  }
  const user = await qb.executeTakeFirst()
  if (!user) {
    throw createError({ statusCode: 400, statusMessage: 'Unknown user.' })
  }
}

/**
 * The slug namespaces this surface manages: records.* plus the app namespace
 * of every code-declared type with slugs of its own (crm.* for contacts).
 */
export function recordsPermissionNamespaces(): string[] {
  const out = new Set(['records.'])
  for (const manifest of getRegisteredRecordTypes()) {
    const app = manifest.permissionPrefix?.split('.')[0]
    if (app) out.add(`${app}.`)
  }
  return [...out].sort()
}

export function isRecordsPermissionSlug(permission: string): boolean {
  return recordsPermissionNamespaces().some(ns => permission.startsWith(ns))
}

/** The slug rule for this surface — grants managed here are record-owned. */
export function assertRecordsPermissionSlug(permission: string): void {
  if (!isRecordsPermissionSlug(permission)) {
    const list = recordsPermissionNamespaces().map(ns => `${ns}*`).join(', ')
    throw createError({ statusCode: 400, statusMessage: `Only ${list} permissions can be managed here.` })
  }
}

// The user's direct grants filtered to the record namespaces, with display meta resolved
// from the runtime permission registry. Orphans keep their raw slug as the
// title — there is no registry entry left to ask.
export async function listRecordsUserGrants(tx: Tx, userId: string): Promise<RecordsUserGrantEntry[]> {
  const rows = await listUserPermissionGrants(tx, userId)
  return rows
    .filter(r => isRecordsPermissionSlug(r.permission))
    .map(r => ({
      permission: r.permission,
      title: getPermissionMeta(r.permission)?.title ?? r.permission,
      orphan: !isRegisteredPermission(r.permission),
      grantedBy: r.granted_by,
      createdAt: r.created_at
    }))
}
