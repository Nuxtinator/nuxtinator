// The order of the records directly under one record (a feature's tasks),
// shared by everyone who sees them: each one's records_entries.position, a
// fractional-indexing key. Records nobody has placed have none and sort after
// the placed ones, oldest first; a record that moves to another parent loses
// its place (hierarchy.ts). The order is part of the parent's breakdown, so
// changing it takes edit access to the parent.

import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing'
import type { Database } from '#core/server/database/schema'
import type { TenantContext } from '#tenant/server'
import { visibleRecordIds } from './list-records'
import { canUpdateRecord } from './type-permissions'

type Tx = Transaction<Database>

/** Whether anyone has placed one of the records directly under `parentId` in its order. */
export async function recordsOrderedUnder(tx: Tx, parentId: string): Promise<boolean> {
  const placed = await tx
    .selectFrom('records_entries')
    .select('id')
    .where('ancestor_ids', '@>', sql<string[]>`ARRAY[${parentId}::uuid]`)
    .where(sql<boolean>`ancestor_ids[cardinality(ancestor_ids)] = ${parentId}::uuid`)
    .where('position', 'is not', null)
    .limit(1)
    .executeTakeFirst()
  return !!placed
}

/**
 * Makes the transaction the only one changing the order under `parentId`
 * until it ends. A caller that also edits one of those records takes it
 * before that edit, so a reorder and the edit can't wait on each other.
 */
export async function lockRecordsOrderUnder(tx: Tx, parentId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`records.order:${parentId}`}, 0))`.execute(tx)
}

/** Whether the caller can change the order of what sits under `parentId`. */
export async function canOrderRecordsUnder(tx: Tx, ctx: TenantContext, parentId: string): Promise<boolean> {
  const parent = await tx.selectFrom('records_entries').select('record_type').where('id', '=', parentId).executeTakeFirst()
  if (!parent || !(await visibleRecordIds(tx, ctx, [parentId])).has(parentId)) return false
  return await canUpdateRecord(tx, ctx, parent.record_type, parentId)
}

/**
 * Puts `recordId` right after `after` among the records directly under
 * `parentId`, or right before `before` when `after` is null. Neighbours that
 * aren't under the parent are ignored, and with neither there is nothing to
 * place against. 403 unless the caller can edit the parent.
 */
export async function placeRecordUnder(
  tx: Tx,
  ctx: TenantContext,
  parentId: string,
  recordId: string,
  neighbours: { after: string | null, before: string | null }
): Promise<void> {
  if (!(await canOrderRecordsUnder(tx, ctx, parentId))) {
    throw createError({ statusCode: 403, statusMessage: 'Only people who can edit a record can change the order of what sits under it' })
  }
  await lockRecordsOrderUnder(tx, parentId)
  const siblings = await tx
    .selectFrom('records_entries')
    .select(['id', 'position'])
    .where('ancestor_ids', '@>', sql<string[]>`ARRAY[${parentId}::uuid]`)
    .where(sql<boolean>`ancestor_ids[cardinality(ancestor_ids)] = ${parentId}::uuid`)
    .orderBy(sql`position asc nulls last`)
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute()
  if (!siblings.some(s => s.id === recordId)) {
    throw createError({ statusCode: 400, statusMessage: 'That record isn\'t directly under this one' })
  }
  const rest = siblings.filter(s => s.id !== recordId)
  const anchor = (id: string | null) => id ? rest.findIndex(s => s.id === id) : -1
  const afterIdx = anchor(neighbours.after)
  const beforeIdx = anchor(neighbours.before)
  if (afterIdx < 0 && beforeIdx < 0) return
  const at = afterIdx >= 0 ? afterIdx + 1 : beforeIdx
  const prev = rest[at - 1] ?? null
  const next = rest[at] ?? null

  // Unplaced records sort after placed ones, so one key fits whenever the
  // record lands among placed ones or right after the last of them; anywhere
  // else every sibling is placed in the order shown.
  const prevRank = prev?.position ?? null
  const nextRank = next?.position ?? null
  if ((!prev || prevRank !== null) && (prevRank === null || nextRank === null || prevRank < nextRank)) {
    await setPosition(tx, parentId, recordId, generateKeyBetween(prevRank, nextRank))
    return
  }
  const order = [...rest.slice(0, at).map(s => s.id), recordId, ...rest.slice(at).map(s => s.id)]
  const keys = generateNKeysBetween(null, null, order.length)
  for (const [i, id] of order.entries()) await setPosition(tx, parentId, id, keys[i]!)
}

// A record that moved to another parent since the siblings were read keeps no place here.
async function setPosition(tx: Tx, parentId: string, id: string, position: string): Promise<void> {
  await tx
    .updateTable('records_entries')
    .set({ position })
    .where('id', '=', id)
    .where(sql<boolean>`ancestor_ids[cardinality(ancestor_ids)] = ${parentId}::uuid`)
    .execute()
}
