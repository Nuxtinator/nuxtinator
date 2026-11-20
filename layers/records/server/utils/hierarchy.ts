// Trees of records: one parent each, of the record's own type or another
// (a task under a deliverable); ancestors, root first, in records_entries.ancestor_ids.

import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { TenantContext } from '#tenant/server'
import { getRecordsHierarchy, type RecordsHierarchy, type RecordsFieldSetting } from './definition-settings'
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
 * Makes the transaction the only one changing the org's trees until it ends,
 * so a move checks loops and copies chains from settled rows.
 */
export async function lockRecordsHierarchy(tx: Tx, ctx: TenantContext): Promise<void> {
  const key = `records.hierarchy:${ctx.orgId ?? ''}`
  await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(tx)
}

function bad(def: RecordsFieldSetting, message: string): never {
  throw createError({ statusCode: 400, statusMessage: `${def.key}: ${message}` })
}

async function ancestorsOf(tx: Tx, id: string): Promise<string[]> {
  const row = await tx.selectFrom('records_entries').select('ancestor_ids').where('id', '=', id).executeTakeFirst()
  return row?.ancestor_ids ?? []
}

// The record's parent and the field (one of its type's `parentKeys`) naming it.
async function parentOf(tx: Tx, parentKeys: string[], id: string): Promise<{ key: string, id: string } | null> {
  const row = await tx
    .selectFrom('records_connections')
    .select(['field_key', 'to_record_id'])
    .where('from_record_id', '=', id)
    .where('field_key', 'in', parentKeys)
    .executeTakeFirst()
  return row ? { key: row.field_key, id: row.to_record_id } : null
}

async function childrenOf(tx: Tx, parentKey: string, id: string): Promise<string[]> {
  const rows = await tx
    .selectFrom('records_connections')
    .select('from_record_id')
    .where('to_record_id', '=', id)
    .where('field_key', '=', parentKey)
    .execute()
  return rows.map(r => r.from_record_id)
}

// Puts `childId` under `parent` through one of its type's `parentKeys` (null
// makes it a root) and rewrites the ancestor chain of the record and of
// everything under it. The record loses its place among its old siblings
// (child-order.ts). Resolves to the ancestors the record gained.
async function setParent(
  tx: Tx,
  parentKeys: string[],
  childId: string,
  parent: { key: string, id: string } | null
): Promise<string[]> {
  const before = new Set(await ancestorsOf(tx, childId))
  await tx
    .deleteFrom('records_connections')
    .where('from_record_id', '=', childId)
    .where('field_key', 'in', parentKeys)
    .execute()
  let chain: string[] = []
  if (parent) {
    await tx
      .insertInto('records_connections')
      .values({ from_record_id: childId, field_key: parent.key, to_record_id: parent.id })
      .execute()
    chain = [...await ancestorsOf(tx, parent.id), parent.id]
  }
  const chainSql = sql`${sql.val(chain)}::uuid[]`
  await sql`
    UPDATE records_entries
    SET ancestor_ids = ${chainSql} || ancestor_ids[array_position(ancestor_ids, ${childId}::uuid):]
    WHERE ancestor_ids @> ARRAY[${childId}::uuid]
  `.execute(tx)
  await sql`UPDATE records_entries SET ancestor_ids = ${chainSql}, position = NULL WHERE id = ${childId}::uuid`.execute(tx)
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
    const parentKeys = hierarchy.parents.map(p => p.key)
    const current = await parentOf(tx, parentKeys, recordId)
    // A parent named by another of the type's parent fields is that field's to clear.
    const mine = current?.key === def.key ? current.id : null
    const next = adds[0] ?? (list.force || (mine !== null && removes.has(mine)) ? null : mine)
    if (next === mine) return []
    if (next) {
      await assertNoLoop(tx, def, recordId, next)
      await assertSeen(tx, ctx, def, next)
    }
    const gained = await setParent(tx, parentKeys, recordId, next ? { key: def.key, id: next } : null)
    return next && !isCreate ? [{ recordId, parentId: next, gained }] : []
  }

  const link = hierarchy.children.find(c => c.key === def.key)
  if (!link) return []
  const childParentKeys = (await getRecordsHierarchy(tx, link.target))?.parents.map(p => p.key) ?? [link.parentKey]
  const current = await childrenOf(tx, link.parentKey, recordId)
  const dropped = list.force ? current.filter(id => !adds.includes(id)) : current.filter(id => removes.has(id))
  for (const childId of dropped) await setParent(tx, childParentKeys, childId, null)
  const moves: RecordsHierarchyMove[] = []
  for (const childId of adds) {
    if (current.includes(childId)) continue
    await assertNoLoop(tx, def, childId, recordId)
    await assertSeen(tx, ctx, def, childId)
    if (!(await canUpdateRecord(tx, ctx, link.target, childId))) {
      throw createError({ statusCode: 403, statusMessage: `${def.key}: you can't move a record you can't edit` })
    }
    const gained = await setParent(tx, childParentKeys, childId, { key: link.parentKey, id: recordId })
    moves.push({ recordId: childId, parentId: recordId, gained })
  }
  return moves
}

/**
 * Removes every link written through parent field `parentKey` and cuts the
 * ancestor chains that ran through one: each record that had such a parent
 * becomes a root, keeping what sits under it. The caller holds `lockRecordsHierarchy`.
 */
export async function dropHierarchyLinks(tx: Tx, parentKey: string): Promise<void> {
  await sql`
    WITH kids AS (
      SELECT from_record_id AS id FROM records_connections WHERE field_key = ${parentKey}
    )
    UPDATE records_entries e
    SET ancestor_ids = CASE
      WHEN e.id IN (SELECT id FROM kids) THEN '{}'::uuid[]
      ELSE e.ancestor_ids[(
        SELECT max(u.ord) FROM unnest(e.ancestor_ids) WITH ORDINALITY AS u(id, ord)
        WHERE u.id IN (SELECT id FROM kids)
      ):]
    END,
    position = CASE WHEN e.id IN (SELECT id FROM kids) THEN NULL ELSE e.position END
    WHERE e.id IN (SELECT id FROM kids) OR e.ancestor_ids && ARRAY(SELECT id FROM kids)
  `.execute(tx)
  await tx.deleteFrom('records_connections').where('field_key', '=', parentKey).execute()
}
