// The client field settings carry kind + promoted-column flag but not the
// storage class; renderers need it to know which values the list feed can
// actually show. Derived through the kernel's own storageOf so the routing
// table lives in one place.
import { isRecordsFilterGroup, storageOf } from '#records'
import type { RecordsStorage } from '#records'
import type { RecordsFieldSetting, RecordsFilterGroup } from '#records/client'
import { VIEWS_GROUPABLE_KINDS } from './views-types'
import type { ViewsDefinition, ViewsLayout } from './views-types'

export function viewsFieldStorage(field: Pick<RecordsFieldSetting, 'kind' | 'column'>): RecordsStorage {
  return storageOf({ kind: field.kind, column: field.column ?? undefined })
}

/** What a tab shows when neither it nor its type names card fields. */
export const VIEWS_DEFAULT_CARD_FIELDS: Record<ViewsLayout, string[]> = {
  kanban: ['status'],
  table: ['status', 'updated_at'],
  list: ['status']
}

/** How records order when a view saves no sort — the list engine's own fallback. */
export const VIEWS_DEFAULT_SORT: { field: string, dir: 'asc' | 'desc' } = {
  field: 'updated_at',
  dir: 'desc'
}

export interface ViewsCardFieldChoice {
  key: string
  label: string
}

// Record columns addressable without a field definition — the server
// accepts these keys in a definition whether or not the type declares them.
const INTRINSIC_KEYS = new Set(['name', 'status', 'created_at', 'updated_at'])

/** Fields a kanban may group by, in the type's field order. */
export function viewsGroupableFields(fields: RecordsFieldSetting[]): RecordsFieldSetting[] {
  return fields.filter(f => VIEWS_GROUPABLE_KINDS.has(f.kind) && !f.hidden && !f.orphan)
}

/**
 * Drops definition entries pointing at keys the record type no longer has.
 * The server rejects a definition referencing an unknown key, so a board
 * whose grouping field was deleted — its card fields or saved filters may
 * name that field too — could otherwise never be saved back into shape.
 */
export function viewsPruneDefinition(
  definition: ViewsDefinition,
  fields: RecordsFieldSetting[]
): ViewsDefinition {
  const known = (key: string) => INTRINSIC_KEYS.has(key) || fields.some(f => f.key === key)
  const next: ViewsDefinition = { ...definition }
  if (next.cardFields) next.cardFields = next.cardFields.filter(known)
  if (next.cardConnections) {
    next.cardConnections = Object.fromEntries(
      Object.entries(next.cardConnections).filter(([key]) => fields.some(f => f.key === key && f.kind === 'connection')))
  }
  if (next.filter) next.filter = viewsPruneFilter(next.filter, known)
  if (next.sort && !known(next.sort.field)) delete next.sort
  return next
}

/** Drops filter rules (and emptied groups) that name fields the type no longer has. */
export function viewsPruneFilter(group: RecordsFilterGroup, known: (key: string) => boolean): RecordsFilterGroup {
  const rules: RecordsFilterGroup['rules'] = []
  for (const node of group.rules) {
    if (isRecordsFilterGroup(node)) {
      const inner = viewsPruneFilter(node, known)
      if (inner.rules.length > 0) rules.push(inner)
    } else if (known(node.field)) {
      rules.push(node)
    }
  }
  return { match: group.match, rules }
}

// Intrinsic record values any view can show. `name` is left out — it always
// renders as the card title / first table column.
const INTRINSIC_CHOICES: ViewsCardFieldChoice[] = [
  { key: 'status', label: 'Status' },
  { key: 'created_at', label: 'Created' },
  { key: 'updated_at', label: 'Updated' }
]

/**
 * The values a view can put on its cards / in its table columns: the record
 * intrinsics plus every field of the type. Values living outside the record
 * row are fetched for the chosen keys by the view feed, so any field can be
 * shown.
 */
export function viewsCardFieldChoices(fields: RecordsFieldSetting[]): ViewsCardFieldChoice[] {
  const statusField = fields.find(f => f.column === 'status')
  const choices = INTRINSIC_CHOICES.map(choice =>
    choice.key === 'status' && statusField
      ? { key: 'status', label: statusField.label }
      : choice)
  for (const field of fields) {
    // Promoted columns are reachable through the intrinsics above.
    if (field.hidden || field.orphan || field.column) continue
    choices.push({ key: field.key, label: field.label })
  }
  return choices
}

/**
 * Every user id a view's feed refers to — values of its user fields, plus
 * the grouping values when a board is grouped by one (those become its
 * columns). The names behind these ids come from a directory page that need
 * not contain them, so the view resolves exactly what it shows.
 */
export function viewsReferencedUserIds(
  items: Array<{ fields?: Record<string, unknown>, groupValues?: string[] }>,
  fields: RecordsFieldSetting[],
  groupFieldKey: string | null
): string[] {
  const userKeys = fields.filter(f => f.kind === 'user_select').map(f => f.key)
  const groupIsUser = !!groupFieldKey && userKeys.includes(groupFieldKey)
  if (userKeys.length === 0) return []

  const ids = new Set<string>()
  const add = (raw: unknown) => {
    if (Array.isArray(raw)) raw.forEach(add)
    else if (typeof raw === 'string' && raw !== '') ids.add(raw)
  }
  for (const item of items) {
    for (const key of userKeys) add(item.fields?.[key])
    if (groupIsUser) add(item.groupValues)
  }
  return [...ids]
}

/**
 * The values a view can order by. The list engine sorts on the record row's
 * own columns and on jsonb-stored values; the other storages live in side
 * tables it cannot order by, so they're left out.
 */
export function viewsSortChoices(fields: RecordsFieldSetting[]): ViewsCardFieldChoice[] {
  const statusField = fields.find(f => f.column === 'status')
  const choices: ViewsCardFieldChoice[] = [
    { key: 'name', label: 'Name' },
    { key: 'status', label: statusField?.label ?? 'Status' },
    { key: 'created_at', label: 'Created' },
    { key: 'updated_at', label: 'Updated' }
  ]
  for (const field of fields) {
    if (field.hidden || field.orphan || field.column) continue
    if (viewsFieldStorage(field) === 'jsonb') {
      choices.push({ key: field.key, label: field.label })
    }
  }
  return choices
}
