// Trees of records for a type with a `hierarchy: 'parent'` field: one parent
// each, ancestors (root first) in records_entries.ancestor_ids.

import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { TenantContext } from '#tenant/server'
import type { RecordsHierarchy, RecordsFieldSetting } from './definition-settings'
import type { RecordsListPatch } from './records-registry'
import { visibleRecordIds } from './list-records'
import { canUpdateRecord } from './type-permissions'

type Tx = Transaction<Database>

/** A record that existed before the write and now sits under `parentId`. */
export interface RecordsHierarchyMove {
  recordId: string
  parentId: string
  /** The ancestors the move put above the record: their audiences now see it. */
  gained: string[]
}

/**
 * Makes the transaction the only one changing the type's trees in this org
 * until it ends, so a move checks loops and copies chains from settled rows.
 */
export async function lockRecordsHierarchy(tx: Tx, ctx: TenantContext, typeKey: string): Promise<void> {
  const key = `records.hierarchy:${ctx.orgId ?? ''}:${typeKey}`
  await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(tx)
}

function bad(def: RecordsFieldSetting, message: string): never {
  throw createError({ statusCode: 400, statusMessage: `${def.key}: ${message}` })
}

async function ancestorsOf(tx: Tx, id: string): Promise<string[]> {
  const row = await tx.selectFrom('records_entries').select('ancestor_ids').where('id', '=', id).executeTakeFirst()
  return row?.ancestor_ids ?? []
}

async function parentOf(tx: Tx, hierarchy: RecordsHierarchy, id: string): Promise<string | null> {
  const row = await tx
    .selectFrom('records_connections')
    .select('to_record_id')
    .where('from_record_id', '=', id)
    .where('field_key', '=', hierarchy.parentKey)
    .executeTakeFirst()
  return row?.to_record_id ?? null
}

async function childrenOf(tx: Tx, hierarchy: RecordsHierarchy, id: string): Promise<string[]> {
  const rows = await tx
    .selectFrom('records_connections')
    .select('from_record_id')
    .where('to_record_id', '=', id)
    .where('field_key', '=', hierarchy.parentKey)
    .execute()
  return rows.map(r => r.from_record_id)
}

// Moves `childId` under `parentId` (null makes it a root) and rewrites the
// ancestor chain of the record and of everything under it. Resolves to the
// ancestors the record gained.
async function setParent(tx: Tx, hierarchy: RecordsHierarchy, childId: string, parentId: string | null): Promise<string[]> {
  const before = new Set(await ancestorsOf(tx, childId))
  await tx
    .deleteFrom('records_connections')
    .where('from_record_id', '=', childId)
    .where('field_key', '=', hierarchy.parentKey)
    .execute()
  let chain: string[] = []
  if (parentId) {
    await tx
      .insertInto('records_connections')
      .values({ from_record_id: childId, field_key: hierarchy.parentKey, to_record_id: parentId })
      .execute()
    chain = [...await ancestorsOf(tx, parentId), parentId]
  }
  const chainSql = sql`${sql.val(chain)}::uuid[]`
  await sql`
    UPDATE records_entries
    SET ancestor_ids = ${chainSql} || ancestor_ids[array_position(ancestor_ids, ${childId}::uuid):]
    WHERE ancestor_ids @> ARRAY[${childId}::uuid]
  `.execute(tx)
  await sql`UPDATE records_entries SET ancestor_ids = ${chainSql} WHERE id = ${childId}::uuid`.execute(tx)
  return chain.filter(id => !before.has(id))
}

async function assertNoLoop(tx: Tx, def: RecordsFieldSetting, childId: string, parentId: string): Promise<void> {
  if (childId === parentId) bad(def, 'a record can\'t sit under itself')
  if ((await ancestorsOf(tx, parentId)).includes(childId)) {
    bad(def, 'a record can\'t sit under one of the records below it')
  }
}

// The record named on the other side of a new link must be one the caller
// can open; one they can't reads as missing.
async function assertSeen(tx: Tx, ctx: TenantContext, def: RecordsFieldSetting, id: string): Promise<void> {
  if (!(await visibleRecordIds(tx, ctx, [id])).has(id)) {
    bad(def, `no ${def.target} record with id ${id}`)
  }
}

/**
 * Applies a patch to one of a type's hierarchy fields on `recordId` and
 * returns the already-existing records it put under a new parent. `isCreate`
 * marks a record the same request created, which is never such a move itself.
 * The caller holds `lockRecordsHierarchy`.
 */
export async function applyHierarchyOp(
  tx: Tx,
  ctx: TenantContext,
  typeKey: string,
  hierarchy: RecordsHierarchy,
  recordId: string,
  def: RecordsFieldSetting,
  list: RecordsListPatch,
  isCreate: boolean
): Promise<RecordsHierarchyMove[]> {
  const adds = [...new Set(list.items.filter(i => !i.delete).map(i => String(i.value)))]
  const removes = new Set(list.items.filter(i => i.delete).map(i => String(i.value)))

  if (def.hierarchy === 'parent') {
    if (adds.length > 1) bad(def, 'takes one record')
    const current = await parentOf(tx, hierarchy, recordId)
    const next = adds[0] ?? (list.force || (current !== null && removes.has(current)) ? null : current)
    if (next === current) return []
    if (next) {
      await assertNoLoop(tx, def, recordId, next)
      await assertSeen(tx, ctx, def, next)
    }
    const gained = await setParent(tx, hierarchy, recordId, next)
    return next && !isCreate ? [{ recordId, parentId: next, gained }] : []
  }

  const current = await childrenOf(tx, hierarchy, recordId)
  const dropped = list.force ? current.filter(id => !adds.includes(id)) : current.filter(id => removes.has(id))
  for (const childId of dropped) await setParent(tx, hierarchy, childId, null)
  const moves: RecordsHierarchyMove[] = []
  for (const childId of adds) {
    if (current.includes(childId)) continue
    await assertNoLoop(tx, def, childId, recordId)
    await assertSeen(tx, ctx, def, childId)
    if (!(await canUpdateRecord(tx, ctx, typeKey, childId))) {
      throw createError({ statusCode: 403, statusMessage: `${def.key}: you can't move a record you can't edit` })
    }
    const gained = await setParent(tx, hierarchy, childId, recordId)
    moves.push({ recordId: childId, parentId: recordId, gained })
  }
  return moves
}
