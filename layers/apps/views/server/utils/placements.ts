// Card movement and hand-picked records. Positions and manual order belong
// to a tab; which records a hand-picked view holds belongs to the view
// (views_items). A drag writes different things by tab:
//
// - Field-grouped boards and grouped lists: the drag is a *record edit* — the
//   grouping field changes through the records kernel's permission check and
//   patch pipeline. What
//   the edit is depends on the field (see dragMode): single-value fields and
//   user fields *move* — the source column's value is swapped for the
//   target's, other values survive, so a card in two user columns leaves the
//   one it was dragged from and stays in the other; multi-selects, tags and
//   connections *add* — the target value joins and the source value stays,
//   so carrying a deliverable into next quarter keeps this quarter too.
//   Grouped by one of the view's own fields, the drag sets that field's
//   value on the view instead (same move/add rule), which takes 'edit'.
// - A board with its own columns: the drag is pure view state — the
//   placement row moves. Records of the view with no placement on the tab
//   sit in its first column on a hand-picked view, and in a leading
//   "No column" lane ('') on a view that shows every matching record.
// - An ungrouped list: the drag only reorders.
//
// Ranks are fractional indexes (lexicographic, via the fractional-indexing
// package). The client sends the target column's record ids in visual order
// after the drop; when the drop lands between already-ranked neighbors one
// key is written, otherwise the listed cards are backfilled in that order —
// which is what turns a field-sorted column into a manually-ordered one on
// first drag.

import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing'
import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { TenantContext } from '#tenant/server'
import { applyFieldPatch, assertRecordVisible, deleteRecord, getRecordType, requireRecordType, requireRecordUpdate, requireShareConfirmation, requireTypePermission, resolveTypePermission } from '#records/server'
import type { RecordsFieldSetting, RecordsSharingMode } from '#records/server'
import { clearViewValues, isViewFieldKey, setViewValues, viewFieldsWithType } from './view-fields'
import { getViewsGroupValues, requireRecordsWriteScope } from './view-records'
import type { ViewDefinition, ViewRow, ViewsAccessLevel, ViewTabDefinition, ViewTabRow } from './views'

type Tx = Transaction<Database>

export const VIEWS_MOVE_ORDER_MAX = 500

export interface ViewsMoveInput {
  recordId: string
  /** Column the card was dragged from; null when it wasn't in one (add). */
  fromColumn: string | null
  /** Column the card was dropped into ('' = the "No value" column). */
  toColumn: string
  /** Target column's record ids in visual order after the drop. */
  columnOrder: string[]
  /** Resends a drag refused for handing the card to someone who can't see it yet. */
  confirmShare?: boolean
}

function badMove(message: string): never {
  throw createError({ statusCode: 400, statusMessage: message })
}

function requireViewEdit(access: ViewsAccessLevel): void {
  if (access === 'view') throw createError({ statusCode: 403, statusMessage: 'View access required: edit' })
}

async function resolveGroupField(tx: Tx, view: ViewRow, key: string): Promise<RecordsFieldSetting> {
  const fields = await viewFieldsWithType(tx, view)
  const field = fields.find(f => f.key === key && !f.orphan)
  if (!field) {
    throw createError({ statusCode: 409, statusMessage: `Grouping field "${key}" no longer exists on this type` })
  }
  return field
}

export type ViewsDragMode = 'move' | 'add'

export function dragMode(field: Pick<RecordsFieldSetting, 'kind'>): ViewsDragMode {
  return field.kind === 'key_select' || field.kind === 'user_select' ? 'move' : 'add'
}

/**
 * The grouping field's value after a drag from `fromColumn` to `toColumn`.
 * Single-value kinds take the target value (or null for "No value"). Move
 * kinds with several values swap the source value for the target. Add kinds
 * keep every value and add the target; dropping on "No value" removes just
 * the source value.
 */
export function nextGroupValues(
  field: Pick<RecordsFieldSetting, 'kind' | 'storage' | 'multiple'>,
  current: string[],
  fromColumn: string | null,
  toColumn: string
): unknown {
  const single = field.kind === 'key_select' || (field.storage === 'user_refs' && !field.multiple)
  if (single) return toColumn === '' ? null : toColumn
  if (dragMode(field) === 'move' || toColumn === '') {
    const next = current.filter(v => v !== fromColumn)
    if (toColumn !== '' && !next.includes(toColumn)) next.push(toColumn)
    return next
  }
  return current.includes(toColumn) ? [...current] : [...current, toColumn]
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Which column keys a field-grouped board accepts: option keys for selects,
// any user for user fields (the kernel checks the user exists), any tag, and
// any record id for connections (the kernel checks the target exists).
function isValidColumn(field: RecordsFieldSetting, key: string): boolean {
  // Every record has a status, so there is no "No value" status column.
  if (key === '') return field.column !== 'status'
  switch (field.kind) {
    case 'user_select': return UUID_RE.test(key)
    case 'connection': return UUID_RE.test(key)
    case 'tags': return key.trim() === key && key.length <= 80
    default: return field.options ? key in field.options : false
  }
}

// The listed ids that may get a placement row: the view's records on a
// hand-picked view, else records of the view's type.
async function rankableIds(tx: Tx, view: ViewRow, columnOrder: string[]): Promise<Set<string>> {
  if ((view.definition as ViewDefinition).picked) return await viewItemSet(tx, view.id)
  const rows = await tx
    .selectFrom('records_entries')
    .select('id')
    .where('id', 'in', columnOrder)
    .where('record_type', '=', view.record_type_key)
    .execute()
  return new Set(rows.map(r => r.id))
}

async function writeRank(
  tx: Tx,
  view: ViewRow,
  tab: ViewTabRow,
  input: ViewsMoveInput
): Promise<void> {
  const { recordId, toColumn, columnOrder } = input
  if (!columnOrder.includes(recordId)) badMove('columnOrder must include the moved record')

  const existing = await tx
    .selectFrom('views_cards')
    .select(['record_id', 'rank'])
    .where('tab_id', '=', tab.id)
    .where('column_key', '=', toColumn)
    .execute()
  const rankOf = new Map(existing.map(r => [r.record_id, r.rank]))

  const idx = columnOrder.indexOf(recordId)
  const prevId = idx > 0 ? columnOrder[idx - 1] : null
  const nextId = idx < columnOrder.length - 1 ? columnOrder[idx + 1] : null
  const prevRank = prevId ? rankOf.get(prevId) ?? null : null
  const nextRank = nextId ? rankOf.get(nextId) ?? null : null

  // Between two ranked neighbors (or at a ranked edge): one key. Otherwise
  // the column isn't fully manual yet — backfill every listed card so the
  // visual order the user just created is what sticks.
  const upserts: Array<{ record_id: string, rank: string }> = []
  const edgeOk = (prevId === null || prevRank !== null) && (nextId === null || nextRank !== null)
  if (edgeOk && (prevRank === null || nextRank === null || prevRank < nextRank)) {
    upserts.push({ record_id: recordId, rank: generateKeyBetween(prevRank, nextRank) })
  } else {
    const eligibleIds = await rankableIds(tx, view, columnOrder)
    const eligible = columnOrder.filter(id => id === recordId || eligibleIds.has(id))
    const keys = generateNKeysBetween(null, null, eligible.length)
    eligible.forEach((id, i) => upserts.push({ record_id: id, rank: keys[i]! }))
  }

  for (const { record_id, rank } of upserts) {
    await tx
      .insertInto('views_cards')
      .values({ view_id: view.id, tab_id: tab.id, record_id, column_key: toColumn, rank })
      .onConflict(oc => oc.columns(['tab_id', 'record_id', 'column_key']).doUpdateSet({ rank }))
      .execute()
  }
}

async function viewItemSet(tx: Tx, viewId: string): Promise<Set<string>> {
  const rows = await tx
    .selectFrom('views_items')
    .select('record_id')
    .where('view_id', '=', viewId)
    .execute()
  return new Set(rows.map(r => r.record_id))
}

export async function assertInView(tx: Tx, ctx: TenantContext, view: ViewRow, recordId: string): Promise<void> {
  await assertRecordVisible(tx, ctx, view.record_type_key, recordId)
  if ((view.definition as ViewDefinition).picked) {
    const item = await tx
      .selectFrom('views_items')
      .select('record_id')
      .where('view_id', '=', view.id)
      .where('record_id', '=', recordId)
      .executeTakeFirst()
    if (!item) badMove('Record is not in this view')
  }
}

/**
 * `access` is the caller's level on the view. On field-grouped tabs a drag to
 * another column edits the record, so 'view' is enough and the records
 * kernel's update check decides; the order within a column, own columns and
 * an ungrouped list's order are view state and need 'edit'.
 */
export async function moveViewsCard(
  tx: Tx,
  ctx: TenantContext,
  view: ViewRow,
  access: ViewsAccessLevel,
  tab: ViewTabRow,
  input: ViewsMoveInput
): Promise<void> {
  const def = tab.definition as ViewTabDefinition
  if (tab.layout === 'table') badMove('Tables are sorted, not ordered by hand')
  if (input.columnOrder.length > VIEWS_MOVE_ORDER_MAX) badMove('columnOrder too large')

  if (def.columns) {
    requireViewEdit(access)
    const picked = !!(view.definition as ViewDefinition).picked
    const noColumn = input.toColumn === '' && !picked
    if (!noColumn && !def.columns.some(c => c.key === input.toColumn)) badMove(`Unknown column "${input.toColumn}"`)
    await assertInView(tx, ctx, view, input.recordId)
    // One column per card on a board with its own columns.
    await tx
      .deleteFrom('views_cards')
      .where('tab_id', '=', tab.id)
      .where('record_id', '=', input.recordId)
      .where('column_key', '!=', input.toColumn)
      .execute()
    await writeRank(tx, view, tab, input)
    return
  }

  if (!def.groupField) {
    requireViewEdit(access)
    if (tab.layout !== 'list') badMove('View has no grouping')
    if (input.toColumn !== '' || (input.fromColumn !== null && input.fromColumn !== '')) {
      badMove('An ungrouped list has no sections')
    }
    await assertInView(tx, ctx, view, input.recordId)
    await writeRank(tx, view, tab, input)
    return
  }

  if (input.fromColumn === input.toColumn) requireViewEdit(access)
  const field = await resolveGroupField(tx, view, def.groupField)
  if (!isValidColumn(field, input.toColumn)) badMove(`Unknown column "${input.toColumn}"`)

  if (input.fromColumn !== input.toColumn) {
    const ownField = isViewFieldKey(view, field.key)
    requireRecordsWriteScope(ctx)
    // A field of the view's own is view state: filling it in takes 'edit'.
    if (ownField) requireViewEdit(access)
    else await requireRecordUpdate(tx, ctx, view.record_type_key, input.recordId)
    await assertInView(tx, ctx, view, input.recordId)
    const row = await tx
      .selectFrom('records_entries')
      .selectAll()
      .where('id', '=', input.recordId)
      .executeTakeFirstOrThrow()
    const current = await getViewsGroupValues(tx, field, [{ ...row, assignedTo: [] }], view)
    const values = current.get(input.recordId) ?? []
    if (input.fromColumn !== null && input.fromColumn !== '' && !values.includes(input.fromColumn)) {
      // The board the drag started from was stale; re-anchor on reality.
      throw createError({ statusCode: 409, statusMessage: 'Card moved since the board loaded — refresh' })
    }
    const next = nextGroupValues(field, values, input.fromColumn, input.toColumn)
    if (ownField) {
      await setViewValues(tx, ctx, view, input.recordId, { [field.key]: next })
    } else {
      await applyFieldPatch(tx, ctx, view.record_type_key, input.recordId, { [field.key]: next }, {
        sharing: input.confirmShare ? 'confirmed' : 'ask'
      })
    }
  } else {
    await assertInView(tx, ctx, view, input.recordId)
  }

  if (access !== 'view') await writeRank(tx, view, tab, input)

  // Sweep the stale source-column rank row when the card left that column.
  const leftSource = dragMode(field) === 'move' || input.toColumn === ''
  if (leftSource && input.fromColumn !== null && input.fromColumn !== input.toColumn) {
    await tx
      .deleteFrom('views_cards')
      .where('tab_id', '=', tab.id)
      .where('record_id', '=', input.recordId)
      .where('column_key', '=', input.fromColumn)
      .execute()
  }
}

/**
 * Adds an existing record to a hand-picked view. With a tab and a column, it
 * also lands at the end of that column (a board with its own columns) or of
 * that tab's list. On types whose boards grant visibility, adding shows the
 * record to everyone who can open the view and lets its editors edit it, so
 * it takes the type's share permission and edit access to the record.
 */
export async function addViewsCard(
  tx: Tx,
  ctx: TenantContext,
  view: ViewRow,
  recordId: string,
  placement: { tab: ViewTabRow, columnKey?: string } | null
): Promise<void> {
  if (!(view.definition as ViewDefinition).picked) {
    badMove('This view shows every matching record — there is nothing to add')
  }
  await assertRecordVisible(tx, ctx, view.record_type_key, recordId)
  const type = await getRecordType(tx, view.record_type_key)
  if (type?.boardsGrantVisibility ?? true) {
    await requireTypePermission(tx, ctx, view.record_type_key, 'share')
    await requireRecordUpdate(tx, ctx, view.record_type_key, recordId)
  }

  const added = await tx
    .insertInto('views_items')
    .values({ view_id: view.id, record_id: recordId })
    .onConflict(oc => oc.columns(['view_id', 'record_id']).doNothing())
    .returning('record_id')
    .executeTakeFirst()
  if (!added) badMove('Record is already in this view')
  if (placement) await placeAtEnd(tx, view, recordId, placement)
}

/**
 * Creates a record on a hand-picked view: it becomes one of the view's own
 * cards (created here), so editors of the view can delete it again. Creating
 * takes the type's create permission.
 */
export async function createViewsCard(
  tx: Tx,
  ctx: TenantContext,
  view: ViewRow,
  fields: Record<string, unknown>,
  placement: { tab: ViewTabRow, columnKey?: string } | null,
  opts: { viewValues?: Record<string, unknown>, sharing?: RecordsSharingMode } = {}
): Promise<{ id: string }> {
  if (!(view.definition as ViewDefinition).picked) {
    badMove('This view shows every matching record — create the record on its type instead')
  }
  requireRecordsWriteScope(ctx)
  await requireRecordType(tx, view.record_type_key, ctx)
  await requireTypePermission(tx, ctx, view.record_type_key, 'create')
  const record = await applyFieldPatch(tx, ctx, view.record_type_key, null, fields)
  await tx
    .insertInto('views_items')
    .values({ view_id: view.id, record_id: record.id, created_here: true })
    .execute()
  // Counted once the card is on the view, so people the view already shows
  // its cards to aren't asked about.
  if (opts.sharing) await requireShareConfirmation(tx, ctx, view.record_type_key, record.id, null, opts.sharing)
  if (opts.viewValues && Object.keys(opts.viewValues).length > 0) {
    await setViewValues(tx, ctx, view, record.id, opts.viewValues)
  }
  if (placement) await placeAtEnd(tx, view, record.id, placement)
  return { id: record.id }
}

/**
 * Deletes a card's record from a hand-picked view. Editors of the view may
 * delete records created on it that no other view holds; anything else needs
 * the type's delete permission.
 */
export async function deleteViewsCardRecord(
  tx: Tx,
  ctx: TenantContext,
  view: ViewRow,
  recordId: string
): Promise<void> {
  if (!(view.definition as ViewDefinition).picked) badMove('Only views of hand-picked records delete their cards')
  requireRecordsWriteScope(ctx)
  const typeKey = view.record_type_key
  const type = await requireRecordType(tx, typeKey, ctx)
  await assertRecordVisible(tx, ctx, typeKey, recordId)
  const item = await tx
    .selectFrom('views_items')
    .select('created_here')
    .where('view_id', '=', view.id)
    .where('record_id', '=', recordId)
    .executeTakeFirst()
  if (!item) badMove('Record is not in this view')
  const elsewhere = await tx
    .selectFrom('views_items')
    .select('view_id')
    .where('record_id', '=', recordId)
    .where('view_id', '<>', view.id)
    .executeTakeFirst()
  const ownCard = item.created_here && !elsewhere && type.boardsGrantVisibility
  if (!ownCard && !(await resolveTypePermission(tx, ctx, typeKey, 'delete'))) {
    throw createError({ statusCode: 403, statusMessage: 'Only cards created on this view, and on no other, can be deleted from it' })
  }
  await deleteRecord(tx, ctx, typeKey, recordId)
}

// Lands a record at the end of a column (a board with its own columns) or of
// an ungrouped list; grouped tabs place records by their field values.
async function placeAtEnd(
  tx: Tx,
  view: ViewRow,
  recordId: string,
  placement: { tab: ViewTabRow, columnKey?: string }
): Promise<void> {
  const { tab } = placement
  const def = tab.definition as ViewTabDefinition
  let columnKey: string
  if (def.columns) {
    columnKey = placement.columnKey ?? def.columns[0]!.key
    if (!def.columns.some(c => c.key === columnKey)) badMove(`Unknown column "${columnKey}"`)
  } else if (tab.layout === 'list' && !def.groupField) {
    columnKey = ''
  } else {
    // Grouped tabs place records by their field values.
    return
  }

  const last = await tx
    .selectFrom('views_cards')
    .select('rank')
    .where('tab_id', '=', tab.id)
    .where('column_key', '=', columnKey)
    .where('rank', 'is not', null)
    .orderBy('rank', 'desc')
    .limit(1)
    .executeTakeFirst()
  await tx
    .insertInto('views_cards')
    .values({
      view_id: view.id,
      tab_id: tab.id,
      record_id: recordId,
      column_key: columnKey,
      rank: generateKeyBetween(last?.rank ?? null, null)
    })
    .execute()
}

/** Takes a record out of a hand-picked view, off every one of its tabs, with its view-field values. */
export async function removeViewsCard(
  tx: Tx,
  view: ViewRow,
  recordId: string
): Promise<void> {
  if (!(view.definition as ViewDefinition).picked) badMove('Only views of hand-picked records remove records')
  await tx
    .deleteFrom('views_items')
    .where('view_id', '=', view.id)
    .where('record_id', '=', recordId)
    .execute()
  await tx
    .deleteFrom('views_cards')
    .where('view_id', '=', view.id)
    .where('record_id', '=', recordId)
    .execute()
  await clearViewValues(tx, view.id, recordId)
}
