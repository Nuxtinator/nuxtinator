// The built-in view of what sits under one record (`builtin.subtasks.<id>`:
// a task's subtasks, a deliverable's tasks), open to anyone who can open it.

import { z } from 'zod'
import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { TenantContext } from '#tenant/server'
import { getRecordTypeFields, recordsHierarchyOf, visibleRecordIds } from '#records/server'
import type { ViewsBuiltInTarget, ViewsBuiltInView } from './builtin-views'
import type { ViewTabDefinition } from './views'

type Tx = Transaction<Database>

const uuidSchema = z.string().uuid()

// What an All levels row shows of the children's type: status, who it's
// assigned to, when it's due, and the progress of what sits under it.
async function levelsDefinition(tx: Tx, typeKey: string): Promise<ViewTabDefinition> {
  const defs = (await getRecordTypeFields(tx, typeKey)).filter(d => !d.orphan && !d.hidden)
  const below = recordsHierarchyOf(defs)?.children[0]?.key
  const cardFields = [
    'status',
    ...defs.filter(d => d.grantsAccess).map(d => d.key),
    ...defs.filter(d => d.due).map(d => d.key),
    ...(below ? [below] : [])
  ]
  return below ? { cardFields, cardConnections: { [below]: 'progress' } } : { cardFields }
}

async function resolveRecord(tx: Tx, ctx: TenantContext, param: string): Promise<ViewsBuiltInTarget | null> {
  if (!uuidSchema.safeParse(param).success) return null
  const record = await tx
    .selectFrom('records_entries')
    .select(['id', 'name', 'record_type', 'ancestor_ids'])
    .where('id', '=', param)
    .executeTakeFirst()
  if (!record) return null
  // A type with several kinds of children opens on the first.
  const link = recordsHierarchyOf(await getRecordTypeFields(tx, record.record_type))?.children[0]
  if (!link) return null
  const visible = await visibleRecordIds(tx, ctx, [record.id, ...record.ancestor_ids])
  if (!visible.has(record.id)) return null
  const shown = record.ancestor_ids.filter(id => visible.has(id))
  const names = shown.length > 0
    ? await tx.selectFrom('records_entries').select(['id', 'name']).where('id', 'in', shown).execute()
    : []
  const nameOf = new Map(names.map(r => [r.id, r.name]))
  return {
    name: record.name,
    recordId: record.id,
    trail: shown.map(id => ({ param: id, name: nameOf.get(id) ?? '' })),
    recordTypeKey: link.target,
    filter: { match: 'all', rules: [{ field: link.parentKey, op: 'under', value: param }] },
    tabs: {
      board: { filter: { match: 'all', rules: [{ field: link.parentKey, op: 'any_of', value: [param] }] } },
      all: { definition: await levelsDefinition(tx, link.target) }
    }
  }
}

export const subtasksBuiltInView: ViewsBuiltInView = {
  key: 'subtasks',
  name: 'Subtasks',
  icon: 'i-lucide-list-tree',
  recordTypeKey: 'task',
  param: { resolve: resolveRecord },
  tabs: [
    { key: 'board', name: 'Board', layout: 'kanban', definition: { groupField: 'status' } },
    { key: 'all', name: 'All levels', layout: 'list', definition: {} }
  ]
}
