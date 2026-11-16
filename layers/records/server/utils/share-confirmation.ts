// Naming someone in an access-granting people field (an assignee) lets them
// see the record, and so does moving it under a parent other people can see.
// When that widens who can see it, the person making the
// change confirms it first: writes that ask for the check fail with a 409
// carrying `RECORDS_SHARE_CONFIRMATION` and the people involved, and succeed
// once resent with the confirmation. System writes (producer layers, inbound
// mail) don't ask, since nobody is there to confirm.

import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import { getMemberPermissions, type TenantContext } from '#tenant/server'
import { getRecordType, recordsAccessGrantingKeys } from './definition-settings'
import type { RecordsHierarchyMove } from './hierarchy'
import { recordsVisibilityScope, visibilityPredicate } from './list-records'
import { getRecordsVisibilitySources } from './records-registry'
import { resolveTypePermission } from './type-permissions'

type Tx = Transaction<Database>

/** `data.code` of the 409 a write gets when it would share a record unconfirmed. */
export const RECORDS_SHARE_CONFIRMATION = 'records.share_confirmation'

/**
 * How a write treats newly named people who can't see the record yet:
 * 'ask' refuses with a 409 until resent as 'confirmed'.
 */
export type RecordsSharingMode = 'ask' | 'confirmed'

export interface RecordsShareConfirmationUser {
  id: string
  name: string
}

// The tenant context `userId` would have in the transaction's org: their
// roles there (membership roles in multi mode, host roles in single mode)
// and their effective permissions.
async function memberContext(tx: Tx, ctx: TenantContext, userId: string): Promise<TenantContext> {
  let roles: string[]
  if (ctx.orgId) {
    const res = await sql<{ roles: string[] | null }>`
      select roles from memberships where user_id = ${userId}::uuid and org_id = ${ctx.orgId}::uuid
    `.execute(tx)
    roles = res.rows[0]?.roles ?? []
  } else {
    const row = await tx.selectFrom('users').select(['roles', 'is_admin']).where('id', '=', userId).executeTakeFirst()
    roles = [...(row?.roles ?? [])]
    if (row?.is_admin && !roles.includes('admin')) roles.push('admin')
  }
  return {
    ...ctx,
    userId,
    role: roles[0] ?? null,
    roles,
    perms: await getMemberPermissions(tx, userId),
    clientId: null
  }
}

/** Whether `userId` sees the record through anything other than an access-granting people field. */
async function seesWithoutAssignment(tx: Tx, ctx: TenantContext, typeKey: string, recordId: string, userId: string): Promise<boolean> {
  const memberCtx = await memberContext(tx, ctx, userId)
  if (await resolveTypePermission(tx, memberCtx, typeKey, 'view_all')) return true
  // Being assigned a record above this one still counts as seeing it.
  const full = await recordsVisibilityScope(tx, typeKey)
  const scope = { ...full, grantKeys: [], inheritedGrantKeys: full.grantKeys }
  const row = await tx
    .selectFrom('records_entries')
    .select('id')
    .where('id', '=', recordId)
    .where(eb => visibilityPredicate(eb, userId, scope))
    .executeTakeFirst()
  return !!row
}

/**
 * The people a write newly named in the record's access-granting fields (other
 * than the caller) who can't otherwise see it. `before` is the record's field
 * values before the write; null for a record the write created.
 */
export async function recordsUnsharedAssignees(
  tx: Tx,
  ctx: TenantContext,
  typeKey: string,
  recordId: string,
  before: Record<string, unknown> | null
): Promise<RecordsShareConfirmationUser[]> {
  const grantKeys = recordsAccessGrantingKeys(typeKey)
  if (grantKeys.length === 0) return []
  const previous = new Set<string>()
  for (const key of grantKeys) {
    const value = before?.[key]
    for (const id of Array.isArray(value) ? value : (typeof value === 'string' ? [value] : [])) previous.add(String(id))
  }
  const rows = await tx
    .selectFrom('records_user_refs')
    .select('user_id')
    .where('record_id', '=', recordId)
    .where('field_key', 'in', grantKeys)
    .execute()
  const added = [...new Set(rows.map(r => r.user_id))].filter(id => id !== ctx.userId && !previous.has(id))
  const unshared: string[] = []
  for (const userId of added) {
    if (!(await seesWithoutAssignment(tx, ctx, typeKey, recordId, userId))) unshared.push(userId)
  }
  if (unshared.length === 0) return []
  const users = await tx.selectFrom('users').select(['id', 'display_name']).where('id', 'in', unshared).execute()
  return users.map(u => ({ id: u.id, name: u.display_name }))
}

/**
 * Refuses (409, `RECORDS_SHARE_CONFIRMATION`) a write that named people who
 * can't otherwise see the record, unless it was confirmed. Call it after every
 * write of the request that affects visibility (adding a card to a shared
 * view, say), so only people the record still hides from are counted.
 */
export async function requireShareConfirmation(
  tx: Tx,
  ctx: TenantContext,
  typeKey: string,
  recordId: string,
  before: Record<string, unknown> | null,
  sharing: RecordsSharingMode
): Promise<void> {
  if (sharing === 'confirmed') return
  const users = await recordsUnsharedAssignees(tx, ctx, typeKey, recordId, before)
  if (users.length === 0) return
  const type = await getRecordType(tx, typeKey)
  const noun = (type?.labelSingular ?? 'record').toLowerCase()
  const names = users.map(u => u.name).join(', ')
  throw createError({
    statusCode: 409,
    statusMessage: `${names} can't see this ${noun} yet. Assigning it shares it with ${users.length === 1 ? 'them' : 'each of them'}.`,
    data: { code: RECORDS_SHARE_CONFIRMATION, users }
  })
}

// Whether anyone but the caller sees one of `ids` through something on the
// record itself: they created it, it's shared with them, it names them in an
// access-granting field, or a place that shares it has an audience.
async function sharedBeyondCaller(tx: Tx, ctx: TenantContext, typeKey: string, ids: string[]): Promise<boolean> {
  const created = await tx
    .selectFrom('records_entries')
    .select('id')
    .where('id', 'in', ids)
    .where('created_by', '<>', ctx.userId)
    .executeTakeFirst()
  if (created) return true
  const shared = await tx
    .selectFrom('records_shares')
    .select('record_id')
    .where('record_id', 'in', ids)
    .where('user_id', '<>', ctx.userId)
    .executeTakeFirst()
  if (shared) return true
  const grantKeys = recordsAccessGrantingKeys(typeKey)
  if (grantKeys.length > 0) {
    const named = await tx
      .selectFrom('records_user_refs')
      .select('record_id')
      .where('record_id', 'in', ids)
      .where('field_key', 'in', grantKeys)
      .where('user_id', '<>', ctx.userId)
      .executeTakeFirst()
    if (named) return true
  }
  const type = await getRecordType(tx, typeKey)
  if (type && !type.boardsGrantVisibility) return false
  for (const source of getRecordsVisibilitySources()) {
    if (!source.describe) continue
    for (const id of ids) {
      if ((await source.describe(tx, ctx, id)).some(via => via.audience.length > 0)) return true
    }
  }
  return false
}

/**
 * Refuses (409, `RECORDS_SHARE_CONFIRMATION`) a write that moved an existing
 * record under a record other people can see, unless it was confirmed:
 * everyone who sees the new parent then sees the record and everything under
 * it. A move that puts nothing new above the record doesn't ask.
 */
export async function requireMoveConfirmation(
  tx: Tx,
  ctx: TenantContext,
  typeKey: string,
  moves: RecordsHierarchyMove[],
  sharing: RecordsSharingMode
): Promise<void> {
  if (sharing === 'confirmed') return
  for (const move of moves) {
    if (move.gained.length === 0) continue
    if (!(await sharedBeyondCaller(tx, ctx, typeKey, move.gained))) continue
    const rows = await tx
      .selectFrom('records_entries')
      .select(['id', 'name'])
      .where('id', 'in', [move.recordId, move.parentId])
      .execute()
    const parent = rows.find(r => r.id === move.parentId)
    const record = rows.find(r => r.id === move.recordId)
    if (!parent || !record) continue
    throw createError({
      statusCode: 409,
      statusMessage: `Everyone who can see "${parent.name}" will see "${record.name}" and everything under it.`,
      data: {
        code: RECORDS_SHARE_CONFIRMATION,
        users: [],
        title: `Move under "${parent.name}"?`,
        confirmLabel: 'Move and share'
      }
    })
  }
}
