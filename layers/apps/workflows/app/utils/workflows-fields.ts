// The client field settings carry kind + promoted-column flag but not the
// storage class; renderers need it to know which values the list feed can
// actually show. Derived through CRM's own storageOf so the routing table
// lives in one place.
import { storageOf } from '#crm'
import type { CrmStorage } from '#crm'
import type { CrmFieldSetting } from '../../../crm/app/utils/field-kinds'
import type { WorkflowsDefinition, WorkflowsViewType } from './workflows-types'

export function workflowsFieldStorage(field: Pick<CrmFieldSetting, 'kind' | 'column'>): CrmStorage {
  return storageOf({ kind: field.kind, column: field.column ?? undefined })
}

/** What a view shows when its definition names no card fields. */
export const WORKFLOWS_DEFAULT_CARD_FIELDS: Record<WorkflowsViewType, string[]> = {
  kanban: ['status'],
  table: ['status', 'updated_at']
}

export interface WorkflowsCardFieldChoice {
  key: string
  label: string
}

// Record columns addressable without a field definition — the server
// accepts these keys in a definition whether or not the type declares them.
const INTRINSIC_KEYS = new Set(['name', 'status', 'created_at', 'updated_at'])

// Kinds a kanban can group by: single/multi selects (columns = their
// options) and user references (columns = the users present). Mirrors the
// server's list in server/utils/views.ts.
const GROUPABLE_KINDS = new Set(['key_select', 'multi_select', 'user_select'])

/** Fields a kanban may group by, in the type's field order. */
export function workflowsGroupableFields(fields: CrmFieldSetting[]): CrmFieldSetting[] {
  return fields.filter(f => GROUPABLE_KINDS.has(f.kind) && !f.hidden && !f.orphan)
}

/**
 * Drops definition entries pointing at keys the record type no longer has.
 * The server rejects a definition referencing an unknown key, so a board
 * whose grouping field was deleted — its card fields or saved filters may
 * name that field too — could otherwise never be saved back into shape.
 */
export function workflowsPruneDefinition(
  definition: WorkflowsDefinition,
  fields: CrmFieldSetting[]
): WorkflowsDefinition {
  const known = (key: string) => INTRINSIC_KEYS.has(key) || fields.some(f => f.key === key)
  const next: WorkflowsDefinition = { ...definition }
  if (next.cardFields) next.cardFields = next.cardFields.filter(known)
  if (next.filters) {
    next.filters = Object.fromEntries(
      Object.entries(next.filters).filter(([key]) => known(key)))
  }
  if (next.sort && !known(next.sort.field)) delete next.sort
  return next
}

// Intrinsic record values any view can show. `name` is left out — it always
// renders as the card title / first table column.
const INTRINSIC_CHOICES: WorkflowsCardFieldChoice[] = [
  { key: 'status', label: 'Status' },
  { key: 'created_at', label: 'Created' },
  { key: 'updated_at', label: 'Updated' }
]

/**
 * The values a view can put on its cards / in its table columns: the
 * intrinsics plus every field the record feed actually carries for that
 * renderer — jsonb-stored values everywhere, the grouping field on a board,
 * assigned users in a table. Storages the feed doesn't carry (entries,
 * connections, channels) are omitted: they would render as an em dash.
 */
export function workflowsCardFieldChoices(
  fields: CrmFieldSetting[],
  opts: { viewType: WorkflowsViewType, groupFieldKey?: string | null }
): WorkflowsCardFieldChoice[] {
  const statusField = fields.find(f => f.column === 'status')
  const choices = INTRINSIC_CHOICES.map(choice =>
    choice.key === 'status' && statusField
      ? { key: 'status', label: statusField.label }
      : choice)
  for (const field of fields) {
    // Promoted columns are reachable through the intrinsics above.
    if (field.hidden || field.orphan || field.column) continue
    const storage = workflowsFieldStorage(field)
    const renderable = storage === 'jsonb'
      || field.key === opts.groupFieldKey
      || (opts.viewType === 'table' && storage === 'user_refs')
    if (renderable) choices.push({ key: field.key, label: field.label })
  }
  return choices
}
