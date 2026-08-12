// The view data feed: what a board or table shows. Everything flows through
// CRM's listRecords, so record visibility and filter/sort validation are
// CRM's — this file only merges the view's saved filters with the caller's
// personal overlay, pages past CRM's per-call limit, and attaches the bits a
// kanban needs on top (grouping-field values per record, placement/rank rows).

import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { TenantContext } from '#tenant/server'
import { listRecords } from '#crm/server'
import type { CrmFieldSetting, CrmRecordListItem } from '#crm/server'
import type { WorkflowsViewDefinition, WorkflowsViewRow } from './views'

type Tx = Transaction<Database>

// A board loads every card at once (columns need the full set); this is the
// safety ceiling. Views past it truncate and say so — the fix is filters.
export const WORKFLOWS_BOARD_CAP = 500
// listRecords clamps limit to its own maximum per call; page in steps.
const PAGE_SIZE = 100

export interface WorkflowsRecordsOverlay {
  filters?: Record<string, unknown>
  q?: string
  sort?: string
  dir?: 'asc' | 'desc'
  /** Table mode only — boards always load the whole (capped) set. */
  limit?: number
  offset?: number
}

export interface WorkflowsPlacement {
  recordId: string
  columnKey: string
  rank: string | null
}

export interface WorkflowsBoardItem extends CrmRecordListItem {
  /** Current values of the grouping field (field-grouped boards only). */
  groupValues?: string[]
}

function mergedListOpts(view: WorkflowsViewRow, overlay: WorkflowsRecordsOverlay) {
  const def = view.definition as WorkflowsViewDefinition
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
export async function getWorkflowsGroupValues(
  tx: Tx,
  field: CrmFieldSetting,
  items: CrmRecordListItem[]
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
      .selectFrom('crm_record_field_entries')
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
      .selectFrom('crm_record_user_refs')
      .select(['record_id', 'user_id'])
      .where('record_id', 'in', ids)
      .where('field_key', '=', field.key)
      .orderBy('created_at', 'asc')
      .execute()
    for (const row of rows) out.get(row.record_id)!.push(row.user_id)
    return out
  }

  return out
}

async function pageThroughRecords(
  tx: Tx,
  ctx: TenantContext,
  typeKey: string,
  opts: { filters: Record<string, unknown>, q?: string, sort?: string, dir?: 'asc' | 'desc', ids?: string[] }
): Promise<{ items: CrmRecordListItem[], total: number }> {
  const items: CrmRecordListItem[] = []
  let total = 0
  for (let offset = 0; offset < WORKFLOWS_BOARD_CAP; offset += PAGE_SIZE) {
    const page = await listRecords(tx, ctx, typeKey, {
      ...opts,
      limit: PAGE_SIZE,
      offset
    })
    items.push(...page.items)
    total = page.total
    if (items.length >= total || page.items.length === 0) break
  }
  return { items: items.slice(0, WORKFLOWS_BOARD_CAP), total }
}

export interface WorkflowsViewRecords {
  items: WorkflowsBoardItem[]
  total: number
  /** True when a board hit WORKFLOWS_BOARD_CAP — some records are not shown. */
  truncated: boolean
  /** All placement/rank rows for the view (kanban only; [] for tables). */
  placements: WorkflowsPlacement[]
}

export async function getWorkflowsViewRecords(
  tx: Tx,
  ctx: TenantContext,
  view: WorkflowsViewRow,
  groupFieldDef: CrmFieldSetting | null,
  overlay: WorkflowsRecordsOverlay
): Promise<WorkflowsViewRecords> {
  const def = view.definition as WorkflowsViewDefinition
  const opts = mergedListOpts(view, overlay)

  if (view.view_type === 'table') {
    const page = await listRecords(tx, ctx, view.record_type_key, {
      ...opts,
      limit: overlay.limit,
      offset: overlay.offset
    })
    return { items: page.items, total: page.total, truncated: false, placements: [] }
  }

  const placementRows = await tx
    .selectFrom('workflows_view_cards')
    .select(['record_id', 'column_key', 'rank'])
    .where('view_id', '=', view.id)
    .execute()
  const placements: WorkflowsPlacement[] = placementRows.map(row => ({
    recordId: row.record_id,
    columnKey: row.column_key,
    rank: row.rank
  }))

  // Custom board: the membership rows decide what loads; visibility and the
  // (shared + personal) filters still narrow what the caller sees.
  if (def.columns) {
    const memberIds = [...new Set(placements.map(p => p.recordId))]
    if (memberIds.length === 0) return { items: [], total: 0, truncated: false, placements }
    const { items, total } = await pageThroughRecords(tx, ctx, view.record_type_key, {
      ...opts,
      ids: memberIds
    })
    return { items, total, truncated: items.length < total, placements }
  }

  const { items, total } = await pageThroughRecords(tx, ctx, view.record_type_key, opts)
  const board: WorkflowsBoardItem[] = items

  if (groupFieldDef) {
    const values = await getWorkflowsGroupValues(tx, groupFieldDef, items)
    for (const item of board) item.groupValues = values.get(item.id) ?? []
  }

  return { items: board, total, truncated: items.length < total, placements }
}
