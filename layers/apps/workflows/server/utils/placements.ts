// Card movement + custom-board membership. The two board modes write
// different things on a drag:
//
// - Field-grouped: the drag is a *record edit* — the grouping field changes
//   through CRM's permission check and patch pipeline. Only the source
//   column's value is swapped for the target's; other values of a
//   multi-value field survive, so a card sitting in two columns moves out of
//   the one it was dragged from and stays in the other.
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
import { applyFieldPatch, assertRecordVisible, getRecordTypeFields, requireRecordUpdate } from '#crm/server'
import type { CrmFieldSetting } from '#crm/server'
import { getWorkflowsGroupValues } from './view-records'
import type { WorkflowsViewDefinition, WorkflowsViewRow } from './views'

type Tx = Transaction<Database>

export const WORKFLOWS_MOVE_ORDER_MAX = 500

export interface WorkflowsMoveInput {
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

async function resolveGroupField(tx: Tx, view: WorkflowsViewRow, key: string): Promise<CrmFieldSetting> {
  const fields = await getRecordTypeFields(tx, view.record_type_key)
  const field = fields.find(f => f.key === key && !f.orphan)
  if (!field) {
    throw createError({ statusCode: 409, statusMessage: `Grouping field "${key}" no longer exists on this type` })
  }
  return field
}

/**
 * Swaps the source column's value for the target's on the grouping field.
 * Single-value kinds just take the target value (or null for "No value");
 * multi-value kinds drop `from`, add `to`, and keep everything else.
 */
function nextGroupValues(
  field: CrmFieldSetting,
  current: string[],
  fromColumn: string | null,
  toColumn: string
): unknown {
  const single = field.kind === 'key_select' || (field.storage === 'user_refs' && !field.multiple)
  if (single) return toColumn === '' ? null : toColumn
  const next = current.filter(v => v !== fromColumn)
  if (toColumn !== '' && !next.includes(toColumn)) next.push(toColumn)
  return next
}

async function writeRank(
  tx: Tx,
  viewId: string,
  input: WorkflowsMoveInput,
  // Custom boards must not mint placement rows for cards the client lists
  // but that live in other columns (one row per card is the invariant);
  // field boards derive membership from the field, so a stray rank row is
  // inert and gets swept later.
  restrictToPlaced: boolean
): Promise<void> {
  const { recordId, toColumn, columnOrder } = input
  if (!columnOrder.includes(recordId)) badMove('columnOrder must include the moved record')

  const existing = await tx
    .selectFrom('workflows_view_cards')
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
      .insertInto('workflows_view_cards')
      .values({ view_id: viewId, record_id, column_key: toColumn, rank })
      .onConflict(oc => oc.columns(['view_id', 'record_id', 'column_key']).doUpdateSet({ rank }))
      .execute()
  }
}

export async function moveWorkflowsCard(
  tx: Tx,
  ctx: TenantContext,
  view: WorkflowsViewRow,
  input: WorkflowsMoveInput
): Promise<void> {
  const def = view.definition as WorkflowsViewDefinition
  if (view.view_type !== 'kanban') badMove('Only kanban views move cards')
  if (input.columnOrder.length > WORKFLOWS_MOVE_ORDER_MAX) badMove('columnOrder too large')

  if (def.columns) {
    if (!def.columns.some(c => c.key === input.toColumn)) badMove(`Unknown column "${input.toColumn}"`)
    await assertRecordVisible(tx, ctx, view.record_type_key, input.recordId)
    const onBoard = await tx
      .selectFrom('workflows_view_cards')
      .select('record_id')
      .where('view_id', '=', view.id)
      .where('record_id', '=', input.recordId)
      .executeTakeFirst()
    if (!onBoard) badMove('Record is not on this board')
    // One column per card on a custom board: clear other placements first.
    await tx
      .deleteFrom('workflows_view_cards')
      .where('view_id', '=', view.id)
      .where('record_id', '=', input.recordId)
      .where('column_key', '!=', input.toColumn)
      .execute()
    await writeRank(tx, view.id, input, true)
    return
  }

  if (!def.groupField) badMove('View has no grouping')
  const field = await resolveGroupField(tx, view, def.groupField)
  const validColumn = (key: string) =>
    key === '' || field.storage === 'user_refs' || (field.options ? key in field.options : false)
  if (!validColumn(input.toColumn)) badMove(`Unknown column "${input.toColumn}"`)

  if (input.fromColumn !== input.toColumn) {
    await requireRecordUpdate(tx, ctx, view.record_type_key, input.recordId)
    const row = await tx
      .selectFrom('crm_records')
      .selectAll()
      .where('id', '=', input.recordId)
      .executeTakeFirstOrThrow()
    const current = await getWorkflowsGroupValues(tx, field, [{ ...row, assignedTo: [] }])
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

  // Sweep the stale source-column rank row (its membership just ended).
  if (input.fromColumn !== null && input.fromColumn !== input.toColumn) {
    await tx
      .deleteFrom('workflows_view_cards')
      .where('view_id', '=', view.id)
      .where('record_id', '=', input.recordId)
      .where('column_key', '=', input.fromColumn)
      .execute()
  }
}

export async function addWorkflowsCard(
  tx: Tx,
  ctx: TenantContext,
  view: WorkflowsViewRow,
  recordId: string,
  columnKey: string
): Promise<void> {
  const def = view.definition as WorkflowsViewDefinition
  if (!def.columns) badMove('Only custom boards add cards — field boards derive membership')
  if (!def.columns.some(c => c.key === columnKey)) badMove(`Unknown column "${columnKey}"`)
  await assertRecordVisible(tx, ctx, view.record_type_key, recordId)

  const existing = await tx
    .selectFrom('workflows_view_cards')
    .select('record_id')
    .where('view_id', '=', view.id)
    .where('record_id', '=', recordId)
    .executeTakeFirst()
  if (existing) badMove('Record is already on this board')

  // Append at the end of the column.
  const last = await tx
    .selectFrom('workflows_view_cards')
    .select('rank')
    .where('view_id', '=', view.id)
    .where('column_key', '=', columnKey)
    .where('rank', 'is not', null)
    .orderBy('rank', 'desc')
    .limit(1)
    .executeTakeFirst()
  await tx
    .insertInto('workflows_view_cards')
    .values({
      view_id: view.id,
      record_id: recordId,
      column_key: columnKey,
      rank: generateKeyBetween(last?.rank ?? null, null)
    })
    .execute()
}

export async function removeWorkflowsCard(
  tx: Tx,
  view: WorkflowsViewRow,
  recordId: string
): Promise<void> {
  const def = view.definition as WorkflowsViewDefinition
  if (!def.columns) badMove('Only custom boards remove cards')
  await tx
    .deleteFrom('workflows_view_cards')
    .where('view_id', '=', view.id)
    .where('record_id', '=', recordId)
    .execute()
}
