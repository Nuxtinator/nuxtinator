// Record share service. records_shares grants a user visibility of one
// record — the list engine's visibility rule (see list-records.ts) admits a
// non-view_all caller to exactly the records shared with them or referencing
// them through a user field. Rows are (record_id, user_id) with the grantor
// stamped in granted_by and a level: 'view' grants visibility only, 'edit'
// additionally grants record-scoped update capability (consumed by the
// type-permission evaluator). Share and unshare both land on the record's
// display timeline.

import type { Transaction } from 'kysely'
import { z } from 'zod'
import type { Database } from '#core/server/database/schema'
import type { RecordsShareLevel } from '../database/schema.d'
import type { TenantContext } from '#tenant/server'
import { recordRecordsActivity } from './records-activity'

type Tx = Transaction<Database>

export type { RecordsShareLevel }

/** One share row, joined with the target user's directory entry. */
export interface RecordsShareEntry {
  userId: string
  name: string
  email: string | null
  avatarUrl: string | null
  level: RecordsShareLevel
  /** User who granted the share; null when that account was deleted. */
  grantedBy: string | null
  createdAt: Date
}

const uuidSchema = z.string().uuid()

// uuid columns reject malformed parameters with a SQL error, so validate up
// front and 400 instead.
function assertUserId(userId: string): void {
  if (!uuidSchema.safeParse(userId).success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid user id.' })
  }
}

// The share target must be a real user — and, when an org context exists, a
// member of the active org (same membership rule as the user directory in
// routes/api/records/users.get.ts). Single mode has no memberships to check.
async function requireShareTarget(
  tx: Tx,
  ctx: TenantContext,
  userId: string
): Promise<{ id: string, display_name: string }> {
  assertUserId(userId)
  let qb = tx
    .selectFrom('users')
    .select(['users.id', 'users.display_name'])
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
  const row = await qb.executeTakeFirst()
  if (!row) {
    throw createError({ statusCode: 400, statusMessage: 'Unknown user.' })
  }
  return row
}

/** Everyone a record is shared with, ordered by user name. */
export async function listShares(tx: Tx, recordId: string): Promise<RecordsShareEntry[]> {
  const rows = await tx
    .selectFrom('records_shares')
    .innerJoin('users', 'users.id', 'records_shares.user_id')
    .select([
      'records_shares.user_id',
      'records_shares.level',
      'records_shares.granted_by',
      'records_shares.created_at',
      'users.display_name',
      'users.email',
      'users.avatar'
    ])
    .where('records_shares.record_id', '=', recordId)
    .orderBy('users.display_name', 'asc')
    .execute()
  return rows.map(r => ({
    userId: r.user_id,
    name: r.display_name,
    email: r.email,
    avatarUrl: r.avatar || null,
    level: r.level,
    grantedBy: r.granted_by,
    createdAt: r.created_at
  }))
}

// Whether the user holds an edit-level share on the record — the
// record-scoped half of the update gate (see type-permissions.ts). The uuid
// pre-check keeps malformed route params from surfacing as SQL cast errors.
export async function hasEditShare(tx: Tx, recordId: string, userId: string): Promise<boolean> {
  if (!uuidSchema.safeParse(recordId).success) return false
  const row = await tx
    .selectFrom('records_shares')
    .select('user_id')
    .where('record_id', '=', recordId)
    .where('user_id', '=', userId)
    .where('level', '=', 'edit')
    .executeTakeFirst()
  return !!row
}

// Upsert grant: a new share inserts at the given level; re-sharing with a
// different level updates the existing row; re-sharing at the same level is
// a no-op and writes no activity. The conflict target is the (record_id,
// user_id) composite PK — mode-independent, unlike the org-scoped unique
// indexes that force bare ON CONFLICT elsewhere, but DO NOTHING needs no
// named target either way. The 'shared' timeline entry carries the target
// user's name plus the granted level.
export async function addShare(
  tx: Tx,
  ctx: TenantContext,
  recordId: string,
  userId: string,
  level: RecordsShareLevel = 'view'
): Promise<void> {
  const target = await requireShareTarget(tx, ctx, userId)
  const note = `${target.display_name} (can ${level})`
  const inserted = await tx
    .insertInto('records_shares')
    .values({
      record_id: recordId,
      user_id: userId,
      level,
      granted_by: ctx.userId
    })
    .onConflict(oc => oc.doNothing())
    .returning('user_id')
    .executeTakeFirst()
  if (inserted) {
    await recordRecordsActivity(tx, ctx, recordId, 'shared', { note })
    return
  }
  const updated = await tx
    .updateTable('records_shares')
    .set({ level })
    .where('record_id', '=', recordId)
    .where('user_id', '=', userId)
    .where('level', '!=', level)
    .returning('user_id')
    .executeTakeFirst()
  if (updated) {
    await recordRecordsActivity(tx, ctx, recordId, 'shared', { note })
  }
}

// Idempotent revoke: removing a share that doesn't exist is a no-op and
// writes no activity. A deleted share row implies the user row still exists
// (shares cascade away with the user), so the name lookup for the timeline
// note resolves within the same transaction.
export async function removeShare(
  tx: Tx,
  ctx: TenantContext,
  recordId: string,
  userId: string
): Promise<void> {
  assertUserId(userId)
  const removed = await tx
    .deleteFrom('records_shares')
    .where('record_id', '=', recordId)
    .where('user_id', '=', userId)
    .returning('user_id')
    .executeTakeFirst()
  if (!removed) return
  const target = await tx
    .selectFrom('users')
    .select('display_name')
    .where('id', '=', userId)
    .executeTakeFirst()
  await recordRecordsActivity(tx, ctx, recordId, 'unshared', { note: target?.display_name })
}
