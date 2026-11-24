// The order of the columns on a view's boards, and of the sections of its
// lists, grouped by a field: set by dragging, kept per grouping field and
// shared by every tab of the view grouped by it. A card's own board (a
// built-in that stands for a record) keeps its order on that record instead.
// Only placed columns are stored (views_column_order), so a column nobody
// placed, such as a new option or a new record to group by, comes after them
// in the board's own order. People who can edit the view change it; on a
// card's board, people who can edit the card. The field's own option order,
// used everywhere else, never changes here.

import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { TenantContext } from '#tenant/server'
import { canOrderRecordsUnder } from '#records/server'
import { VIEWS_GROUPABLE_KINDS } from '../../app/utils/views-types'
import { viewsColumnPositionsFor, viewsPlaceColumn, type ViewsColumnPositions } from '../../app/utils/views-column-order'
import { builtInOf } from './builtin-views'
import { viewFieldsWithType } from './view-fields'
import type { ViewRow, ViewsAccessLevel, ViewTabDefinition } from './views'

type Tx = Transaction<Database>

/** Grouping field key → the positions of its placed columns. */
export type ViewsColumnOrder = Record<string, ViewsColumnPositions>

export const VIEWS_COLUMN_ORDER_MAX = 500
const COLUMN_KEY_MAX = 80

type Owner = { viewId: string } | { recordId: string }

// A stored view keeps its own order; a built-in keeps one only when it stands
// for a record.
function ownerOf(view: ViewRow): Owner | null {
  const builtIn = builtInOf(view)
  if (!builtIn) return { viewId: view.id }
  return builtIn.recordId ? { recordId: builtIn.recordId } : null
}

function bad(message: string): never {
  throw createError({ statusCode: 400, statusMessage: message })
}

function rowsOf(tx: Tx, owner: Owner) {
  const query = tx.selectFrom('views_column_order')
  return 'viewId' in owner ? query.where('view_id', '=', owner.viewId) : query.where('record_id', '=', owner.recordId)
}

/** The view's column order for every grouping field that has one. */
export async function readColumnOrder(tx: Tx, view: ViewRow): Promise<ViewsColumnOrder> {
  const owner = ownerOf(view)
  if (!owner) return {}
  const rows = await rowsOf(tx, owner).select(['field_key', 'column_key', 'position']).execute()
  const out: ViewsColumnOrder = {}
  for (const r of rows) (out[r.field_key] ??= {})[r.column_key] = r.position
  return out
}

async function requireOrderAccess(tx: Tx, ctx: TenantContext, view: ViewRow, access: ViewsAccessLevel): Promise<Owner> {
  const owner = ownerOf(view)
  if (!owner) {
    throw createError({ statusCode: 403, statusMessage: 'Built-in views can\'t be changed. Copy it to make one of your own.' })
  }
  if ('recordId' in owner) {
    // Ordering a card's board is a change to the card.
    if (ctx.clientId && !ctx.perms.has('records.write')) {
      throw createError({ statusCode: 403, statusMessage: 'Permission required: records.write' })
    }
    if (!(await canOrderRecordsUnder(tx, ctx, owner.recordId))) {
      throw createError({ statusCode: 403, statusMessage: 'Only people who can edit a record can change the column order on its board' })
    }
  } else if (access === 'view') {
    throw createError({ statusCode: 403, statusMessage: 'View access required: edit' })
  }
  return owner
}

// One change at a time to a field's order, so two drags can't both read the
// same neighbours.
async function lockOrder(tx: Tx, owner: Owner, field: string): Promise<void> {
  const id = 'viewId' in owner ? owner.viewId : owner.recordId
  await sql`select pg_advisory_xact_lock(hashtextextended(${`views.columns:${id}:${field}`}, 0))`.execute(tx)
}

// The field must group one of the view's boards or lists.
async function requireGroupingField(tx: Tx, view: ViewRow, field: string): Promise<void> {
  const def = (await viewFieldsWithType(tx, view)).find(f => f.key === field && !f.orphan)
  if (!def || !VIEWS_GROUPABLE_KINDS.has(def.kind)) bad(`"${field}" doesn't group records`)
  const tabs: Array<{ layout: string, definition: unknown }> = builtInOf(view)?.tabs ?? await tx
    .selectFrom('views_tabs')
    .select(['layout', 'definition'])
    .where('view_id', '=', view.id)
    .execute()
  const grouped = tabs.some(t => (t.layout === 'kanban' || t.layout === 'list')
    && (t.definition as ViewTabDefinition).groupField === field)
  if (!grouped) bad(`No board or list of this view is grouped by "${field}"`)
}

function cleanOrder(order: string[]): string[] {
  const keys = order.filter(k => k !== '')
  if (keys.length > VIEWS_COLUMN_ORDER_MAX) bad('Too many columns')
  if (keys.some(k => k.length > COLUMN_KEY_MAX)) bad('Unknown column')
  if (new Set(keys).size !== keys.length) bad('Each column is listed once')
  return keys
}

async function writePositions(
  tx: Tx,
  ctx: TenantContext,
  owner: Owner,
  field: string,
  before: ViewsColumnPositions,
  after: ViewsColumnPositions,
  replaced: boolean
): Promise<void> {
  const changed = Object.keys(after).filter(k => after[k] !== before[k])
  const gone = replaced ? Object.keys(before).filter(k => !(k in after)) : []
  const remove = [...changed, ...gone]
  if (remove.length > 0) {
    let del = tx.deleteFrom('views_column_order').where('field_key', '=', field).where('column_key', 'in', remove)
    del = 'viewId' in owner ? del.where('view_id', '=', owner.viewId) : del.where('record_id', '=', owner.recordId)
    await del.execute()
  }
  if (changed.length === 0) return
  await tx
    .insertInto('views_column_order')
    .values(changed.map(column_key => ({
      view_id: 'viewId' in owner ? owner.viewId : null,
      record_id: 'recordId' in owner ? owner.recordId : null,
      field_key: field,
      column_key,
      position: after[column_key]!,
      updated_by: ctx.userId
    })))
    .execute()
}

async function positionsOf(tx: Tx, owner: Owner, field: string): Promise<ViewsColumnPositions> {
  const rows = await rowsOf(tx, owner).select(['column_key', 'position']).where('field_key', '=', field).execute()
  return Object.fromEntries(rows.map(r => [r.column_key, r.position]))
}

/**
 * Places column `key` of the view's tabs grouped by `field` where it sits in
 * `order`: every column's key as shown after the drag. Between two placed
 * columns only `key` is written; otherwise the listed columns are all placed
 * in that order. Returns the field's positions.
 */
export async function placeViewColumn(
  tx: Tx,
  ctx: TenantContext,
  view: ViewRow,
  access: ViewsAccessLevel,
  input: { field: string, key: string, order: string[] }
): Promise<ViewsColumnPositions> {
  const owner = await requireOrderAccess(tx, ctx, view, access)
  if (input.key === '') bad('The "No value" column stays first')
  const order = cleanOrder(input.order)
  if (!order.includes(input.key)) bad('order must include the moved column')
  await requireGroupingField(tx, view, input.field)
  await lockOrder(tx, owner, input.field)
  const before = await positionsOf(tx, owner, input.field)
  const { positions, replaced } = viewsPlaceColumn(before, order, input.key)
  await writePositions(tx, ctx, owner, input.field, before, positions, replaced)
  return positions
}

/**
 * Sets the order of the view's tabs grouped by `field` to `keys` first, in
 * that order; columns not listed follow in the board's own order.
 */
export async function setViewColumnOrder(
  tx: Tx,
  ctx: TenantContext,
  view: ViewRow,
  access: ViewsAccessLevel,
  field: string,
  keys: string[]
): Promise<ViewsColumnPositions> {
  const owner = await requireOrderAccess(tx, ctx, view, access)
  const order = cleanOrder(keys)
  await requireGroupingField(tx, view, field)
  await lockOrder(tx, owner, field)
  const before = await positionsOf(tx, owner, field)
  const positions = viewsColumnPositionsFor(order)
  await writePositions(tx, ctx, owner, field, before, positions, true)
  return positions
}

/** Gives the new view `targetViewId` the column order `source` shows. */
export async function copyColumnOrder(tx: Tx, ctx: TenantContext, source: ViewRow, targetViewId: string): Promise<void> {
  const owner = ownerOf(source)
  if (!owner) return
  const rows = await rowsOf(tx, owner).select(['field_key', 'column_key', 'position']).execute()
  if (rows.length === 0) return
  await tx
    .insertInto('views_column_order')
    .values(rows.map(r => ({
      view_id: targetViewId,
      record_id: null,
      field_key: r.field_key,
      column_key: r.column_key,
      position: r.position,
      updated_by: ctx.userId
    })))
    .execute()
}
