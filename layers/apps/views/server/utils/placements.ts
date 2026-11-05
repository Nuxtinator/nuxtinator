// Card movement + custom-board membership. The two board modes write
// different things on a drag:
//
// - Field-grouped: the drag is a *record edit* — the grouping field changes
//   through the records kernel's permission check and patch pipeline. What
//   the edit is depends on the field (see dragMode): single-value fields and
//   user fields *move* — the source column's value is swapped for the
//   target's, other values survive, so a card in two user columns leaves the
//   one it was dragged from and stays in the other; multi-selects, tags and
//   connections *add* — the target value joins and the source value stays,
//   so carrying a deliverable into next quarter keeps this quarter too.
// - Custom board: the drag is pure view state — the placement row moves.
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
import { applyFieldPatch, assertRecordVisible, getRecordTypeFields, requireRecordUpdate } from '#records/server'
import type { RecordsFieldSetting } from '#records/server'
import { getViewsGroupValues } from './view-records'
import type { ViewDefinition, ViewRow } from './views'

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
}

function badMove(message: string): never {
  throw createError({ statusCode: 400, statusMessage: message })
}

async function resolveGroupField(tx: Tx, view: ViewRow, key: string): Promise<RecordsFieldSetting> {
  const fields = await getRecordTypeFields(tx, view.record_type_key)
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
  if (key === '') return true
  switch (field.kind) {
    case 'user_select': return UUID_RE.test(key)
    case 'connection': return UUID_RE.test(key)
    case 'tags': return key.trim() === key && key.length <= 80
    default: return field.options ? key in field.options : false
  }
}

async function writeRank(
  tx: Tx,
  viewId: string,
  input: ViewsMoveInput,
  // Custom boards must not mint placement rows for cards the client lists
  // but that live in other columns (one row per card is the invariant);
  // field boards derive membership from the field, so a stray rank row is
  // inert and gets swept later.
  restrictToPlaced: boolean
): Promise<void> {
  const { recordId, toColumn, columnOrder } = input
  if (!columnOrder.includes(recordId)) badMove('columnOrder must include the moved record')

  const existing = await tx
    .selectFrom('views_cards')
    .select(['record_id', 'rank'])
    .where('view_id', '=', viewId)
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
    const eligible = restrictToPlaced
      ? columnOrder.filter(id => id === recordId || rankOf.has(id))
      : columnOrder
    const keys = generateNKeysBetween(null, null, eligible.length)
    eligible.forEach((id, i) => upserts.push({ record_id: id, rank: keys[i]! }))
  }

  for (const { record_id, rank } of upserts) {
    await tx
      .insertInto('views_cards')
      .values({ view_id: viewId, record_id, column_key: toColumn, rank })
      .onConflict(oc => oc.columns(['view_id', 'record_id', 'column_key']).doUpdateSet({ rank }))
      .execute()
  }
}

export async function moveViewsCard(
  tx: Tx,
  ctx: TenantContext,
  view: ViewRow,
  input: ViewsMoveInput
): Promise<void> {
  const def = view.definition as ViewDefinition
  if (view.view_type !== 'kanban') badMove('Only kanban views move cards')
  if (input.columnOrder.length > VIEWS_MOVE_ORDER_MAX) badMove('columnOrder too large')

  if (def.columns) {
    if (!def.columns.some(c => c.key === input.toColumn)) badMove(`Unknown column "${input.toColumn}"`)
    await assertRecordVisible(tx, ctx, view.record_type_key, input.recordId)
    const onBoard = await tx
      .selectFrom('views_cards')
      .select('record_id')
      .where('view_id', '=', view.id)
      .where('record_id', '=', input.recordId)
      .executeTakeFirst()
    if (!onBoard) badMove('Record is not on this board')
    // One column per card on a custom board: clear other placements first.
    await tx
      .deleteFrom('views_cards')
      .where('view_id', '=', view.id)
      .where('record_id', '=', input.recordId)
      .where('column_key', '!=', input.toColumn)
      .execute()
    await writeRank(tx, view.id, input, true)
    return
  }

  if (!def.groupField) badMove('View has no grouping')
  const field = await resolveGroupField(tx, view, def.groupField)
  if (!isValidColumn(field, input.toColumn)) badMove(`Unknown column "${input.toColumn}"`)

  if (input.fromColumn !== input.toColumn) {
    await requireRecordUpdate(tx, ctx, view.record_type_key, input.recordId)
    const row = await tx
      .selectFrom('records_entries')
      .selectAll()
      .where('id', '=', input.recordId)
      .executeTakeFirstOrThrow()
    const current = await getViewsGroupValues(tx, field, [{ ...row, assignedTo: [] }])
    const values = current.get(input.recordId) ?? []
    if (input.fromColumn !== null && input.fromColumn !== '' && !values.includes(input.fromColumn)) {
      // The board the drag started from was stale; re-anchor on reality.
      throw createError({ statusCode: 409, statusMessage: 'Card moved since the board loaded — refresh' })
    }
    await applyFieldPatch(tx, ctx, view.record_type_key, input.recordId, {
      [field.key]: nextGroupValues(field, values, input.fromColumn, input.toColumn)
    })
  } else {
    await assertRecordVisible(tx, ctx, view.record_type_key, input.recordId)
  }

  await writeRank(tx, view.id, input, false)

  // Sweep the stale source-column rank row when the card left that column.
  const leftSource = dragMode(field) === 'move' || input.toColumn === ''
  if (leftSource && input.fromColumn !== null && input.fromColumn !== input.toColumn) {
    await tx
      .deleteFrom('views_cards')
      .where('view_id', '=', view.id)
      .where('record_id', '=', input.recordId)
      .where('column_key', '=', input.fromColumn)
      .execute()
  }
}

export async function addViewsCard(
  tx: Tx,
  ctx: TenantContext,
  view: ViewRow,
  recordId: string,
  columnKey: string
): Promise<void> {
  const def = view.definition as ViewDefinition
  if (!def.columns) badMove('Only custom boards add cards — field boards derive membership')
  if (!def.columns.some(c => c.key === columnKey)) badMove(`Unknown column "${columnKey}"`)
  await assertRecordVisible(tx, ctx, view.record_type_key, recordId)

  const existing = await tx
    .selectFrom('views_cards')
    .select('record_id')
    .where('view_id', '=', view.id)
    .where('record_id', '=', recordId)
    .executeTakeFirst()
  if (existing) badMove('Record is already on this board')

  // Append at the end of the column.
  const last = await tx
    .selectFrom('views_cards')
    .select('rank')
    .where('view_id', '=', view.id)
    .where('column_key', '=', columnKey)
    .where('rank', 'is not', null)
    .orderBy('rank', 'desc')
    .limit(1)
    .executeTakeFirst()
  await tx
    .insertInto('views_cards')
    .values({
      view_id: view.id,
      record_id: recordId,
      column_key: columnKey,
      rank: generateKeyBetween(last?.rank ?? null, null)
    })
    .execute()
}

export async function removeViewsCard(
  tx: Tx,
  view: ViewRow,
  recordId: string
): Promise<void> {
  const def = view.definition as ViewDefinition
  if (!def.columns) badMove('Only custom boards remove cards')
  await tx
    .deleteFrom('views_cards')
    .where('view_id', '=', view.id)
    .where('record_id', '=', recordId)
    .execute()
}
