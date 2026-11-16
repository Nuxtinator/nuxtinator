// Hierarchies: a type whose manifest marks a connection to itself as
// `hierarchy: 'parent'` (a task's parent task) arranges its records in trees.
// A link is one records_connections row from the child, keyed by the parent
// field, whichever side wrote it, so a record has at most one parent. Each
// record's ancestors, root first, sit in records_entries.ancestor_ids; every
// move rewrites them for the record and everything under it, and a move that
// would put a record under itself is refused.
//
// Whoever can see or edit a record can see or edit everything under it (see
// list-records.ts and type-permissions.ts), so putting a record under a
// parent shares it with the parent's audience. Linking a record from its
// parent's side therefore takes the right to edit that record.

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
  /** The record stayed in the tree it was in (same root before and after). */
  sameTree: boolean
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
// ancestor chain of the record and of everything under it. Resolves to
// whether the record stayed in the same tree.
async function setParent(tx: Tx, hierarchy: RecordsHierarchy, childId: string, parentId: string | null): Promise<boolean> {
  const rootBefore = (await ancestorsOf(tx, childId))[0] ?? childId
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
  return (chain[0] ?? childId) === rootBefore
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
    const sameTree = await setParent(tx, hierarchy, recordId, next)
    return next && !isCreate ? [{ recordId, parentId: next, sameTree }] : []
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
    const sameTree = await setParent(tx, hierarchy, childId, recordId)
    moves.push({ recordId: childId, parentId: recordId, sameTree })
  }
  return moves
}
