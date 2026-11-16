// The built-in view of what sits under one task: `builtin.subtasks.<taskId>`.
// Its Board tab holds the task's direct subtasks by status; its All levels tab
// lists everything under the task at any depth. A subtask with subtasks of
// its own opens the same way, so a big task is worked one level at a time.
// Anyone who can open the task can open its view, and a card added on either
// tab becomes a subtask of the task.

import { z } from 'zod'
import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { TenantContext } from '#tenant/server'
import { visibleRecordIds } from '#records/server'
import type { ViewsBuiltInTarget, ViewsBuiltInView } from './builtin-views'

type Tx = Transaction<Database>

const uuidSchema = z.string().uuid()

async function resolveTask(tx: Tx, ctx: TenantContext, param: string): Promise<ViewsBuiltInTarget | null> {
  if (!uuidSchema.safeParse(param).success) return null
  const task = await tx
    .selectFrom('records_entries')
    .select(['id', 'name', 'ancestor_ids'])
    .where('id', '=', param)
    .where('record_type', '=', 'task')
    .executeTakeFirst()
  if (!task) return null
  const visible = await visibleRecordIds(tx, ctx, [task.id, ...task.ancestor_ids])
  if (!visible.has(task.id)) return null
  const shown = task.ancestor_ids.filter(id => visible.has(id))
  const names = shown.length > 0
    ? await tx.selectFrom('records_entries').select(['id', 'name']).where('id', 'in', shown).execute()
    : []
  const nameOf = new Map(names.map(r => [r.id, r.name]))
  return {
    name: task.name,
    recordId: task.id,
    trail: shown.map(id => ({ param: id, name: nameOf.get(id) ?? '' }))
  }
}

export const subtasksBuiltInView: ViewsBuiltInView = {
  key: 'subtasks',
  name: 'Subtasks',
  icon: 'i-lucide-list-tree',
  recordTypeKey: 'task',
  filter: param => ({ match: 'all', rules: [{ field: 'parent', op: 'under', value: param }] }),
  param: { resolve: resolveTask },
  tabs: [
    {
      key: 'board',
      name: 'Board',
      layout: 'kanban',
      definition: { groupField: 'status' },
      filter: param => ({ match: 'all', rules: [{ field: 'parent', op: 'any_of', value: [param] }] })
    },
    {
      key: 'all',
      name: 'All levels',
      layout: 'list',
      definition: {
        cardFields: ['status', 'assignee', 'due_date', 'subtasks'],
        cardConnections: { subtasks: 'progress' }
      }
    }
  ]
}
