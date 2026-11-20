// The tab data feed: what a board, table, list or calendar shows. Everything flows
// through the records kernel's listRecords, so record visibility and
// filter/sort validation are the kernel's — this file only combines the
// view's base filter with the tab's, pages past the kernel's per-call limit,
// and attaches the bits boards and lists need on top (grouping-field values
// per record, the columns a connection-grouped board shows, values and
// progress for card fields the list rows don't carry, placement/rank rows).

import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { TenantContext } from '#tenant/server'
import type { RecordsCardConnectionDisplay, RecordsConnectedRecord } from '#records'
import {
  closingRulesOf,
  getRecordType,
  getRecordTypeFields,
  hydrateRecords,
  listRecords,
  requireRecordType,
  requireTypePermission,
  resolveTypePermission,
  visibleRecordIds
} from '#records/server'
import type { RecordsFieldSetting, RecordsFilterGroup, RecordListItem, RecordsListOpts } from '#records/server'
import { isSortableField, ownCardsQuery, ownsItsCards, TIMESTAMP_KEYS, type ViewDefinition, type ViewRow, type ViewTabDefinition, type ViewTabRow } from './views'
import { isViewFieldKey, readViewValues, viewFieldGroupValues, viewFieldsOf, viewFieldsWithType, viewVirtualFields } from './view-fields'

type Tx = Transaction<Database>

// A board loads every card at once (columns need the full set); past this
// it shows none and asks for a filter. It also caps a list's page and a
// calendar's records.
export const VIEWS_BOARD_CAP = 500

export interface ViewsRecordsOverlay {
  q?: string
  sort?: string
  dir?: 'asc' | 'desc'
  /** Tables and lists page; boards always load the whole (capped) set. A list with no limit loads the cap. */
  limit?: number
  offset?: number
  /** Calendar only: the first and last day on screen (YYYY-MM-DD). */
  from?: string
  to?: string
}

export interface ViewsPlacement {
  recordId: string
  columnKey: string
  rank: string | null
}

export interface ViewsBoardItem extends RecordListItem {
  createdAt: Date
  updatedAt: Date
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
  /** Created on this hand-picked view and on no other: its editors can delete it. */
  ownCard?: true
  /** Values of the view's own fields, keyed by field key (views with fields only). */
  viewValues?: Record<string, unknown>
}

/** The card layout a view renders: its own choice, else its type's default. */
export interface ViewsCardLayout {
  fields: string[]
  connections: Record<string, RecordsCardConnectionDisplay>
  /** True when the view stores its own layout instead of the type default. */
  custom: boolean
  /** The type's cover field: its first image tops each board card. */
  cover?: string
  /** Card fields that stay on the card when empty, so they can be set from it. */
  showEmpty?: string[]
}

// What a tab shows when neither it nor its type names card fields.
const DEFAULT_CARD_FIELDS: Record<ViewTabRow['layout'], string[]> = {
  kanban: ['status'],
  table: ['status', 'updated_at'],
  list: ['status'],
  calendar: []
}

export async function effectiveCardLayout(tx: Tx, view: ViewRow, tab: ViewTabRow): Promise<ViewsCardLayout> {
  const def = tab.definition as ViewTabDefinition
  const type = await getRecordType(tx, view.record_type_key)
  const cover = type?.card?.cover ? { cover: type.card.cover } : {}
  if (def.cardFields) {
    const showEmpty = def.cardShowEmpty?.length ? { showEmpty: def.cardShowEmpty } : {}
    return { fields: def.cardFields, connections: def.cardConnections ?? {}, custom: true, ...cover, ...showEmpty }
  }
  return {
    fields: type?.card?.fields ?? DEFAULT_CARD_FIELDS[tab.layout],
    connections: type?.card?.connections ?? {},
    custom: false,
    ...cover
  }
}

// A list row carries the record's own columns and its jsonb blob. Everything
// else — multi-selects, tags, links, user references, connections, channel
// links, files — lives in a side table, which is why the list engine leaves
// it out.
const SIDE_TABLE_STORAGES = new Set(['entries', 'user_refs', 'connections', 'channels', 'attachments'])

/**
 * Fills in the side-table values for the card fields a view actually shows.
 * CRM's hydrator reads one query per storage class over the whole page, so
 * this costs a handful of queries for the page rather than any per record —
 * but it is skipped entirely when no card field needs it.
 */
async function attachCardFieldValues(
  tx: Tx,
  ctx: TenantContext,
  view: ViewRow,
  layout: ViewsCardLayout,
  items: ViewsBoardItem[]
): Promise<void> {
  const chosen = layout.cover ? [...layout.fields, layout.cover] : layout.fields
  if (items.length === 0 || chosen.length === 0) return

  const defs = await getRecordTypeFields(tx, view.record_type_key)
  const shown = defs.filter(d => chosen.includes(d.key) && !d.orphan)
  await attachConnectionProgress(tx, ctx, view, shown, layout, items)
  // Refs are stored on the row but shown by their source's label.
  const keys = shown.filter(d => SIDE_TABLE_STORAGES.has(d.storage) || d.kind === 'ref').map(d => d.key)
  if (keys.length === 0) return

  const hydrated = await hydrateRecords(tx, ctx, view.record_type_key, items)
  const byId = new Map(hydrated.map(h => [h.id, h.fields]))
  const connectionKeys = new Set(shown.filter(d => d.kind === 'connection').map(d => d.key))
  for (const item of items) {
    const fields = byId.get(item.id)
    if (!fields) continue
    const picked: Record<string, unknown> = {}
    for (const key of keys) {
      const value = fields[key] ?? null
      // Cards show only the linked records the viewer can open.
      picked[key] = connectionKeys.has(key) && Array.isArray(value)
        ? (value as RecordsConnectedRecord[]).filter(v => !v.hidden)
        : value
    }
    item.fields = picked
  }
}

// Linked and done totals for connection card fields shown as count or
// progress, over the linked records the viewer can open. "Done" means the
// linked record sits in a closed status of its own type (a done task). Links
// written from the other side count too (a task's subtasks are the tasks
// naming it as their parent). One query per such field over the whole page.
async function attachConnectionProgress(
  tx: Tx,
  ctx: TenantContext,
  view: ViewRow,
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
    const forward = await tx
      .selectFrom('records_connections as c')
      .innerJoin('records_entries as t', 't.id', 'c.to_record_id')
      .select(['c.from_record_id as owner', 'c.to_record_id as linked', 't.status'])
      .where('c.from_record_id', 'in', ids)
      .where('c.field_key', '=', def.key)
      .execute()
    const reverseKeys = targetDefs
      .filter(d => d.kind === 'connection' && d.target === view.record_type_key && d.reverseKey === def.key)
      .map(d => d.key)
    const reverse = reverseKeys.length === 0
      ? []
      : await tx
          .selectFrom('records_connections as c')
          .innerJoin('records_entries as t', 't.id', 'c.from_record_id')
          .select(['c.to_record_id as owner', 'c.from_record_id as linked', 't.status'])
          .where('c.to_record_id', 'in', ids)
          .where('c.field_key', 'in', reverseKeys)
          .execute()
    const rows = [...forward, ...reverse]
    const visible = await visibleRecordIds(tx, ctx, [...new Set(rows.map(r => r.linked))])
    const totals = new Map<string, { total: number, done: number }>()
    const counted = new Set<string>()
    for (const row of rows) {
      if (!visible.has(row.linked) || counted.has(`${row.owner}:${row.linked}`)) continue
      counted.add(`${row.owner}:${row.linked}`)
      const entry = totals.get(row.owner) ?? { total: 0, done: 0 }
      entry.total++
      if (row.status && closed.includes(row.status)) entry.done++
      totals.set(row.owner, entry)
    }
    for (const item of items) {
      item.progress = { ...(item.progress ?? {}), [def.key]: totals.get(item.id) ?? { total: 0, done: 0 } }
    }
  }
}

// How a board or list orders when its tab saves no sort: oldest first, so
// new cards land at the bottom. Other layouts keep the list engine's order.
export function viewsDefaultSort(tab: Pick<ViewTabRow, 'layout'>): ViewTabDefinition['sort'] {
  return tab.layout === 'kanban' || tab.layout === 'list' ? { field: 'created_at', dir: 'asc' } : undefined
}

// The tab narrows the view: both filters apply. The caller's sort overrides
// the tab's saved one for this request only.
function mergedListOpts(view: ViewRow, tab: ViewTabRow, overlay: ViewsRecordsOverlay) {
  const viewDef = view.definition as ViewDefinition
  const tabDef = tab.definition as ViewTabDefinition
  const saved = tabDef.sort ?? viewsDefaultSort(tab)
  return {
    where: [viewDef.filter, tabDef.filter].filter(f => !!f && f.rules.length > 0) as NonNullable<ViewDefinition['filter']>[],
    q: overlay.q,
    sort: overlay.sort ?? saved?.field,
    dir: overlay.dir ?? saved?.dir,
    virtualFields: viewVirtualFields(view)
  }
}

async function attachViewValues(tx: Tx, view: ViewRow, items: ViewsBoardItem[]): Promise<void> {
  if (viewFieldsOf(view).length === 0 || items.length === 0) return
  const values = await readViewValues(tx, view, items.map(i => i.id))
  for (const item of items) item.viewValues = values.get(item.id) ?? {}
}

// List rows carry the record's snake_case columns; the feed serves the same
// camelCase timestamps as the records list route.
function withTimestamps(items: RecordListItem[]): ViewsBoardItem[] {
  return items.map(item => ({ ...item, createdAt: item.created_at, updatedAt: item.updated_at }))
}

/** The records added to a hand-picked view. */
export async function viewItemIds(tx: Tx, viewId: string): Promise<string[]> {
  const rows = await tx
    .selectFrom('views_items')
    .select('record_id')
    .where('view_id', '=', viewId)
    .execute()
  return rows.map(r => r.record_id)
}

/**
 * Reads the grouping field's current value(s) per record, storage-aware. A
 * field of the view's own (`view` given and the key is one of its fields)
 * reads from views_values.
 */
export async function getViewsGroupValues(
  tx: Tx,
  field: RecordsFieldSetting,
  items: RecordListItem[],
  view?: Pick<ViewRow, 'id' | 'definition'>
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (items.length === 0) return out
  if (view && isViewFieldKey(view, field.key)) {
    return await viewFieldGroupValues(tx, view, field.key, items.map(i => i.id))
  }

  if (field.storage === 'promoted') {
    // An unset status sits in the type's default column.
    const fallback = typeof field.default === 'string' ? field.default : null
    for (const item of items) {
      const status = item.status ?? fallback
      out.set(item.id, status ? [status] : [])
    }
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
  if (!(await resolveTypePermission(tx, ctx, field.target, 'read'))) return []
  try {
    await requireRecordType(tx, field.target, ctx)
  } catch {
    return []
  }
  const page = await listRecords(tx, ctx, field.target, {
    sort: 'created_at',
    dir: 'asc',
    limit: VIEWS_CONNECTION_COLUMN_CAP
  })
  return page.items.map(r => ({ key: r.id, label: r.name }))
}

async function loadBoardRecords(
  tx: Tx,
  ctx: TenantContext,
  typeKey: string,
  opts: RecordsListOpts
): Promise<{ items: RecordListItem[], total: number }> {
  return await listRecords(tx, ctx, typeKey, { ...opts, limit: VIEWS_BOARD_CAP, offset: 0 }, { maxLimit: VIEWS_BOARD_CAP })
}

export interface ViewRecords {
  items: ViewsBoardItem[]
  total: number
  /** Not every matching record is in this response: a list's later pages, or a board or calendar past VIEWS_BOARD_CAP. */
  truncated: boolean
  /** A board with more matching records than VIEWS_BOARD_CAP: none are sent, since part of a board would mislead; a filter narrows it. */
  tooMany?: boolean
  /** The tab's placement/rank rows (boards and lists; [] for tables). */
  placements: ViewsPlacement[]
  /** Connection-grouped tabs: the target records that make the columns. */
  groupColumns?: ViewsGroupColumn[]
  /** The card layout the cards, list rows and table columns render. */
  card: ViewsCardLayout
  /** Calendars: the first records with no date, and how many there are. */
  unscheduled?: { items: ViewsBoardItem[], total: number }
}

// A connected app reads a view's records only with the records.read scope;
// for a session, the records kernel's checks alone decide.
export function requireRecordsReadScope(ctx: TenantContext): void {
  if (ctx.clientId && !ctx.perms.has('records.read')) {
    throw createError({ statusCode: 403, statusMessage: 'Permission required: records.read' })
  }
}

// A connected app changes records, and values on them, only with the
// records.write scope; for a session, the records kernel's checks alone decide.
export function requireRecordsWriteScope(ctx: TenantContext): void {
  if (ctx.clientId && !ctx.perms.has('records.write')) {
    throw createError({ statusCode: 403, statusMessage: 'Permission required: records.write' })
  }
}

export async function getViewRecords(
  tx: Tx,
  ctx: TenantContext,
  view: ViewRow,
  tab: ViewTabRow,
  groupFieldDef: RecordsFieldSetting | null,
  overlay: ViewsRecordsOverlay
): Promise<ViewRecords> {
  // A view shows what the type lets each viewer see: the same read and app
  // checks as the records routes.
  await requireTypePermission(tx, ctx, view.record_type_key, 'read')
  await requireRecordType(tx, view.record_type_key, ctx)
  const viewDef = view.definition as ViewDefinition
  const opts: RecordsListOpts = mergedListOpts(view, tab, overlay)
  // A saved sort on a field that has since gone falls back to the default order.
  const savedSort = (tab.definition as ViewTabDefinition).sort
  if (!overlay.sort && savedSort && !isSortableField(await viewFieldsWithType(tx, view), savedSort.field)) {
    opts.sort = viewsDefaultSort(tab)?.field
    opts.dir = viewsDefaultSort(tab)?.dir
  }
  const card = await effectiveCardLayout(tx, view, tab)
  if (viewDef.picked) {
    opts.ids = await viewItemIds(tx, view.id)
    if (opts.ids.length === 0) return { items: [], total: 0, truncated: false, placements: [], card }
  }

  if (tab.layout === 'calendar') {
    return await getCalendarRecords(tx, ctx, view, tab, opts, card, overlay)
  }

  if (tab.layout === 'table') {
    const page = await listRecords(tx, ctx, view.record_type_key, {
      ...opts,
      limit: overlay.limit,
      offset: overlay.offset
    })
    const items = withTimestamps(page.items)
    await attachCardFieldValues(tx, ctx, view, card, items)
    await attachViewValues(tx, view, items)
    await markOwnCards(tx, view, items)
    return { items, total: page.total, truncated: false, placements: [], card }
  }

  const placementRows = await tx
    .selectFrom('views_cards')
    .select(['record_id', 'column_key', 'rank'])
    .where('tab_id', '=', tab.id)
    .execute()
  const placements: ViewsPlacement[] = placementRows.map(row => ({
    recordId: row.record_id,
    columnKey: row.column_key,
    rank: row.rank
  }))

  // A list pages in the order it shows: rows placed by hand on the tab first.
  const offset = tab.layout === 'list' ? overlay.offset ?? 0 : 0
  const { items: rows, total } = tab.layout === 'list'
    ? await listRecords(tx, ctx, view.record_type_key, {
        ...opts,
        orderFirst: sql`(select min(vc.rank) from views_cards vc where vc.tab_id = ${tab.id}::uuid and vc.record_id = records_entries.id)`,
        limit: overlay.limit ?? VIEWS_BOARD_CAP,
        offset
      }, { maxLimit: VIEWS_BOARD_CAP })
    : await loadBoardRecords(tx, ctx, view.record_type_key, opts)
  if (tab.layout === 'kanban' && total > VIEWS_BOARD_CAP) {
    return { items: [], total, truncated: true, tooMany: true, placements: [], card }
  }
  const items = withTimestamps(rows)

  let groupColumns: ViewsGroupColumn[] | undefined
  if (groupFieldDef) {
    const values = await getViewsGroupValues(tx, groupFieldDef, rows, view)
    for (const item of items) item.groupValues = values.get(item.id) ?? []
    if (groupFieldDef.kind === 'connection') groupColumns = await connectionColumns(tx, ctx, groupFieldDef)
  }
  await attachCardFieldValues(tx, ctx, view, card, items)
  await attachViewValues(tx, view, items)
  await markOwnCards(tx, view, items)

  return { items, total, truncated: offset + items.length < total, placements, groupColumns, card }
}

// How many records with no date a calendar's Unscheduled tray lists.
export const VIEWS_UNSCHEDULED_CAP = 50

function shiftDay(day: string, by: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + by)
  return d.toISOString().slice(0, 10)
}

// The records on the days a calendar shows. The range widens by a day each
// side so the client can place datetimes on its own timezone's days. With an
// end field a record shows on every day from its start to its end. With no
// range (an MCP read) it loads every dated record, capped.
async function getCalendarRecords(
  tx: Tx,
  ctx: TenantContext,
  view: ViewRow,
  tab: ViewTabRow,
  opts: RecordsListOpts,
  card: ViewsCardLayout,
  overlay: ViewsRecordsOverlay
): Promise<ViewRecords> {
  const def = tab.definition as ViewTabDefinition
  const fields = await viewFieldsWithType(tx, view)
  const start = def.dateField!
  const end = def.endField && fields.some(f => f.key === def.endField && !f.orphan) ? def.endField : undefined
  type Rule = RecordsFilterGroup['rules'][number]
  let range: RecordsFilterGroup
  if (overlay.from && overlay.to) {
    const from = shiftDay(overlay.from, -1)
    const to = shiftDay(overlay.to, 1)
    const startsIn: Rule = { field: start, op: 'between', value: [from, to] }
    range = end
      ? {
          match: 'any',
          rules: [startsIn, {
            match: 'all',
            rules: [{ field: start, op: 'before', value: to }, { field: end, op: 'after', value: from }]
          }]
        }
      : { match: 'all', rules: [startsIn] }
  } else {
    range = { match: 'all', rules: [{ field: start, op: 'not_empty' }] }
  }
  const sorted: RecordsListOpts = !opts.sort && isSortableField(fields, start)
    ? { ...opts, sort: start, dir: 'asc' }
    : opts
  const { items: rows, total } = await loadBoardRecords(tx, ctx, view.record_type_key, {
    ...sorted,
    where: [...(opts.where ?? []), range]
  })
  const items = withTimestamps(rows)

  let unscheduled: ViewRecords['unscheduled']
  if (!TIMESTAMP_KEYS.has(start)) {
    const page = await listRecords(tx, ctx, view.record_type_key, {
      ...opts,
      where: [...(opts.where ?? []), { match: 'all', rules: [{ field: start, op: 'empty' }] }],
      limit: VIEWS_UNSCHEDULED_CAP,
      offset: 0
    })
    unscheduled = { items: withTimestamps(page.items), total: page.total }
  }

  const all = [...items, ...(unscheduled?.items ?? [])]
  await attachViewValues(tx, view, all)
  await markOwnCards(tx, view, all)
  return { items, total, truncated: items.length < total, placements: [], card, unscheduled }
}

async function markOwnCards(tx: Tx, view: ViewRow, items: ViewsBoardItem[]): Promise<void> {
  if (items.length === 0 || !(await ownsItsCards(tx, view))) return
  const own = new Set((await ownCardsQuery(tx, view.id).select('i.record_id').execute()).map(r => r.record_id))
  for (const item of items) if (own.has(item.id)) item.ownCard = true
}
