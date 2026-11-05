// The view data feed: what a board or table shows. Everything flows through
// the records kernel's listRecords, so record visibility and filter/sort
// validation are the kernel's — this file only merges the view's saved
// filters with the caller's personal overlay, pages past the kernel's
// per-call limit, and attaches the bits a kanban needs on top (grouping-field
// values per record, the columns a connection-grouped board shows, values
// and progress for card fields the list rows don't carry, placement/rank
// rows).

import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { TenantContext } from '#tenant/server'
import type { RecordsCardConnectionDisplay } from '#records'
import {
  closingRulesOf,
  getRecordType,
  getRecordTypeFields,
  hydrateRecords,
  listRecords
} from '#records/server'
import type { RecordsFieldSetting, RecordListItem } from '#records/server'
import type { ViewDefinition, ViewRow } from './views'

type Tx = Transaction<Database>

// A board loads every card at once (columns need the full set); this is the
// safety ceiling. Views past it truncate and say so — the fix is filters.
export const VIEWS_BOARD_CAP = 500
// listRecords clamps limit to its own maximum per call; page in steps.
const PAGE_SIZE = 100

export interface ViewsRecordsOverlay {
  filters?: Record<string, unknown>
  q?: string
  sort?: string
  dir?: 'asc' | 'desc'
  /** Table mode only — boards always load the whole (capped) set. */
  limit?: number
  offset?: number
}

export interface ViewsPlacement {
  recordId: string
  columnKey: string
  rank: string | null
}

export interface ViewsBoardItem extends RecordListItem {
  /** Current values of the grouping field (field-grouped boards only). */
  groupValues?: string[]
  /**
   * Values for the view's card fields that a list row cannot carry — the
   * ones stored in side tables. Present only for those keys; promoted and
   * jsonb values are already on the row.
   */
  fields?: Record<string, unknown>
  /** Per connection card field shown as count or progress: linked and done totals. */
  progress?: Record<string, { total: number, done: number }>
}

/** The card layout a view renders: its own choice, else its type's default. */
export interface ViewsCardLayout {
  fields: string[]
  connections: Record<string, RecordsCardConnectionDisplay>
  /** True when the view stores its own layout instead of the type default. */
  custom: boolean
}

// What a view shows when neither it nor its type names card fields.
const DEFAULT_CARD_FIELDS: Record<'kanban' | 'table', string[]> = {
  kanban: ['status'],
  table: ['status', 'updated_at']
}

export async function effectiveCardLayout(tx: Tx, view: ViewRow): Promise<ViewsCardLayout> {
  const def = view.definition as ViewDefinition
  if (def.cardFields) {
    return { fields: def.cardFields, connections: def.cardConnections ?? {}, custom: true }
  }
  const type = await getRecordType(tx, view.record_type_key)
  return {
    fields: type?.card?.fields ?? DEFAULT_CARD_FIELDS[view.view_type],
    connections: type?.card?.connections ?? {},
    custom: false
  }
}

// A list row carries the record's own columns and its jsonb blob. Everything
// else — multi-selects, tags, links, user references, connections, channel
// links — lives in a side table, which is why the list engine leaves it out.
const SIDE_TABLE_STORAGES = new Set(['entries', 'user_refs', 'connections', 'channels'])

/**
 * Fills in the side-table values for the card fields a view actually shows.
 * CRM's hydrator reads one query per storage class over the whole page, so
 * this costs a handful of queries for the page rather than any per record —
 * but it is skipped entirely when no card field needs it.
 */
async function attachCardFieldValues(
  tx: Tx,
  view: ViewRow,
  layout: ViewsCardLayout,
  items: ViewsBoardItem[]
): Promise<void> {
  const chosen = layout.fields
  if (items.length === 0 || chosen.length === 0) return

  const defs = await getRecordTypeFields(tx, view.record_type_key)
  const shown = defs.filter(d => chosen.includes(d.key) && !d.orphan)
  await attachConnectionProgress(tx, shown, layout, items)
  const keys = shown.filter(d => SIDE_TABLE_STORAGES.has(d.storage)).map(d => d.key)
  if (keys.length === 0) return

  const hydrated = await hydrateRecords(tx, view.record_type_key, items)
  const byId = new Map(hydrated.map(h => [h.id, h.fields]))
  for (const item of items) {
    const fields = byId.get(item.id)
    if (!fields) continue
    const picked: Record<string, unknown> = {}
    for (const key of keys) picked[key] = fields[key] ?? null
    item.fields = picked
  }
}

// Linked and done totals for connection card fields shown as count or
// progress. "Done" means the linked record sits in a closed status of its own
// type (a done task). One query per such field over the whole page.
async function attachConnectionProgress(
  tx: Tx,
  shown: RecordsFieldSetting[],
  layout: ViewsCardLayout,
  items: ViewsBoardItem[]
): Promise<void> {
  const ids = items.map(i => i.id)
  for (const def of shown) {
    const display = layout.connections[def.key]
    if (def.kind !== 'connection' || !def.target || (display !== 'count' && display !== 'progress')) continue
    const targetType = await getRecordType(tx, def.target)
    const targetDefs = targetType ? await getRecordTypeFields(tx, def.target) : []
    const closed = targetType ? closingRulesOf(targetType, targetDefs).closedStatuses : []
    const rows = await tx
      .selectFrom('records_connections as c')
      .innerJoin('records_entries as t', 't.id', 'c.to_record_id')
      .select(['c.from_record_id', 't.status'])
      .where('c.from_record_id', 'in', ids)
      .where('c.field_key', '=', def.key)
      .execute()
    const totals = new Map<string, { total: number, done: number }>()
    for (const row of rows) {
      const entry = totals.get(row.from_record_id) ?? { total: 0, done: 0 }
      entry.total++
      if (row.status && closed.includes(row.status)) entry.done++
      totals.set(row.from_record_id, entry)
    }
    for (const item of items) {
      item.progress = { ...(item.progress ?? {}), [def.key]: totals.get(item.id) ?? { total: 0, done: 0 } }
    }
  }
}

function mergedListOpts(view: ViewRow, overlay: ViewsRecordsOverlay) {
  const def = view.definition as ViewDefinition
  // Personal overlay wins per key — a personal filter narrows or replaces
  // the shared one, never widens visibility (that's CRM's layer).
  const filters = { ...(def.filters ?? {}), ...(overlay.filters ?? {}) }
  return {
    filters,
    q: overlay.q,
    sort: overlay.sort ?? def.sort?.field,
    dir: overlay.dir ?? def.sort?.dir
  }
}

/** Reads the grouping field's current value(s) per record, storage-aware. */
export async function getViewsGroupValues(
  tx: Tx,
  field: RecordsFieldSetting,
  items: RecordListItem[]
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (items.length === 0) return out

  if (field.storage === 'promoted') {
    for (const item of items) out.set(item.id, item.status ? [item.status] : [])
    return out
  }
  if (field.storage === 'jsonb') {
    for (const item of items) {
      const value = (item.data as Record<string, unknown>)[field.key]
      out.set(item.id, typeof value === 'string' && value !== '' ? [value] : [])
    }
    return out
  }

  const ids = items.map(i => i.id)
  for (const item of items) out.set(item.id, [])

  if (field.storage === 'entries') {
    const rows = await tx
      .selectFrom('records_field_entries')
      .select(['record_id', 'payload', 'normalized_value'])
      .where('record_id', 'in', ids)
      .where('field_key', '=', field.key)
      .orderBy('sort_order', 'asc')
      .execute()
    for (const row of rows) {
      const payload = row.payload as Record<string, unknown>
      const value = String(payload.value ?? row.normalized_value ?? '')
      if (value) out.get(row.record_id)!.push(value)
    }
    return out
  }

  if (field.storage === 'user_refs') {
    const rows = await tx
      .selectFrom('records_user_refs')
      .select(['record_id', 'user_id'])
      .where('record_id', 'in', ids)
      .where('field_key', '=', field.key)
      .orderBy('created_at', 'asc')
      .execute()
    for (const row of rows) out.get(row.record_id)!.push(row.user_id)
    return out
  }

  // Forward edges only: a board groups by what the record points at.
  if (field.storage === 'connections') {
    const rows = await tx
      .selectFrom('records_connections')
      .select(['from_record_id', 'to_record_id'])
      .where('from_record_id', 'in', ids)
      .where('field_key', '=', field.key)
      .execute()
    for (const row of rows) out.get(row.from_record_id)!.push(row.to_record_id)
    return out
  }

  return out
}

/** A column of a connection-grouped board: one record of the target type. */
export interface ViewsGroupColumn {
  key: string
  label: string
}

// The columns of a connection-grouped board are the target type's records
// the caller can see, oldest first so a newly added column lands at the end.
export const VIEWS_CONNECTION_COLUMN_CAP = 100

async function connectionColumns(tx: Tx, ctx: TenantContext, field: RecordsFieldSetting): Promise<ViewsGroupColumn[]> {
  if (!field.target) return []
  const page = await listRecords(tx, ctx, field.target, {
    sort: 'created_at',
    dir: 'asc',
    limit: VIEWS_CONNECTION_COLUMN_CAP
  })
  return page.items.map(r => ({ key: r.id, label: r.name }))
}

async function pageThroughRecords(
  tx: Tx,
  ctx: TenantContext,
  typeKey: string,
  opts: { filters: Record<string, unknown>, q?: string, sort?: string, dir?: 'asc' | 'desc', ids?: string[] }
): Promise<{ items: RecordListItem[], total: number }> {
  const items: RecordListItem[] = []
  let total = 0
  for (let offset = 0; offset < VIEWS_BOARD_CAP; offset += PAGE_SIZE) {
    const page = await listRecords(tx, ctx, typeKey, {
      ...opts,
      limit: PAGE_SIZE,
      offset
    })
    items.push(...page.items)
    total = page.total
    if (items.length >= total || page.items.length === 0) break
  }
  return { items: items.slice(0, VIEWS_BOARD_CAP), total }
}

export interface ViewRecords {
  items: ViewsBoardItem[]
  total: number
  /** True when a board hit VIEWS_BOARD_CAP — some records are not shown. */
  truncated: boolean
  /** All placement/rank rows for the view (kanban only; [] for tables). */
  placements: ViewsPlacement[]
  /** Connection-grouped boards: the target records that make the columns. */
  groupColumns?: ViewsGroupColumn[]
  /** The card layout the cards and table columns render. */
  card: ViewsCardLayout
}

export async function getViewRecords(
  tx: Tx,
  ctx: TenantContext,
  view: ViewRow,
  groupFieldDef: RecordsFieldSetting | null,
  overlay: ViewsRecordsOverlay
): Promise<ViewRecords> {
  const def = view.definition as ViewDefinition
  const opts = mergedListOpts(view, overlay)
  const card = await effectiveCardLayout(tx, view)

  if (view.view_type === 'table') {
    const page = await listRecords(tx, ctx, view.record_type_key, {
      ...opts,
      limit: overlay.limit,
      offset: overlay.offset
    })
    await attachCardFieldValues(tx, view, card, page.items)
    return { items: page.items, total: page.total, truncated: false, placements: [], card }
  }

  const placementRows = await tx
    .selectFrom('views_cards')
    .select(['record_id', 'column_key', 'rank'])
    .where('view_id', '=', view.id)
    .execute()
  const placements: ViewsPlacement[] = placementRows.map(row => ({
    recordId: row.record_id,
    columnKey: row.column_key,
    rank: row.rank
  }))

  // Custom board: the membership rows decide what loads; visibility and the
  // (shared + personal) filters still narrow what the caller sees.
  if (def.columns) {
    const memberIds = [...new Set(placements.map(p => p.recordId))]
    if (memberIds.length === 0) return { items: [], total: 0, truncated: false, placements, card }
    const { items, total } = await pageThroughRecords(tx, ctx, view.record_type_key, {
      ...opts,
      ids: memberIds
    })
    await attachCardFieldValues(tx, view, card, items)
    return { items, total, truncated: items.length < total, placements, card }
  }

  const { items, total } = await pageThroughRecords(tx, ctx, view.record_type_key, opts)
  const board: ViewsBoardItem[] = items

  let groupColumns: ViewsGroupColumn[] | undefined
  if (groupFieldDef) {
    const values = await getViewsGroupValues(tx, groupFieldDef, items)
    for (const item of board) item.groupValues = values.get(item.id) ?? []
    if (groupFieldDef.kind === 'connection') groupColumns = await connectionColumns(tx, ctx, groupFieldDef)
  }
  await attachCardFieldValues(tx, view, card, board)

  return { items: board, total, truncated: items.length < total, placements, groupColumns, card }
}
