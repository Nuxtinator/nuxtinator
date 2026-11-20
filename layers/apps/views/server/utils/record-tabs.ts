// A built-in board's own choices for the record it stands for (the board of
// a card's tasks): its sort, which everyone who opens that board sees and
// only people who can edit the record change, like the order set by dragging
// there. Each record keeps its own; without a row the tab's own sort applies
// (Manual on a card's board).

import { z } from 'zod'
import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { TenantContext } from '#tenant/server'
import { canOrderRecordsUnder, RECORDS_POSITION_KEY, recordsOrderedUnder } from '#records/server'
import { isSortableField, type ViewRow, type ViewTabDefinition, type ViewTabRow } from './views'
import { viewFieldsWithType } from './view-fields'
import { builtInOf } from './builtin-views'
import { requireRecordsWriteScope, viewsDefaultSort } from './view-records'

type Tx = Transaction<Database>

export interface ViewRecordTab {
  sort?: { field: string, dir: 'asc' | 'desc' }
}

const recordTabSchema = z.object({
  sort: z.object({
    field: z.string().min(1).max(80),
    dir: z.enum(['asc', 'desc'])
  }).strict().nullable().optional()
}).strict()

// Tables sort from their column headers for the session; calendars order by date.
const SORTED_LAYOUTS = new Set(['kanban', 'list'])

/**
 * The record's choices on each of `tabIds`, when the view is a built-in that
 * stands for one. A sort on a field that has since gone is left out.
 */
export async function readRecordTabs(tx: Tx, view: ViewRow, tabIds: string[]): Promise<Map<string, ViewRecordTab>> {
  const recordId = builtInOf(view)?.recordId
  if (!recordId || tabIds.length === 0) return new Map()
  const rows = await tx
    .selectFrom('views_record_tabs')
    .select(['tab_id', 'definition'])
    .where('record_id', '=', recordId)
    .where('tab_id', 'in', tabIds)
    .execute()
  if (rows.length === 0) return new Map()
  const fields = await viewFieldsWithType(tx, view)
  return new Map(rows.map((r) => {
    const { sort } = r.definition as ViewRecordTab
    return [r.tab_id, sort && isSortableField(fields, sort.field) ? { sort } : {}]
  }))
}

/** Replaces the record's choices on `tab`; an empty set deletes the row. */
export async function setRecordTab(
  tx: Tx,
  ctx: TenantContext,
  view: ViewRow,
  tab: Pick<ViewTabRow, 'id' | 'layout' | 'definition'>,
  raw: unknown
): Promise<ViewRecordTab> {
  const recordId = builtInOf(view)?.recordId
  if (!recordId) {
    throw createError({ statusCode: 400, statusMessage: 'Only the board of a record keeps a sort of its own' })
  }
  requireRecordsWriteScope(ctx)
  if (!(await canOrderRecordsUnder(tx, ctx, recordId))) {
    throw createError({ statusCode: 403, statusMessage: 'Only people who can edit a record can change how its board is sorted' })
  }
  const parsed = recordTabSchema.safeParse(raw ?? {})
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.issues[0]?.message ?? 'Invalid sort' })
  }
  const choices: ViewRecordTab = {}
  if (parsed.data.sort) {
    if (!SORTED_LAYOUTS.has(tab.layout)) {
      throw createError({ statusCode: 400, statusMessage: 'Only boards and lists keep a sort' })
    }
    if (!isSortableField(await viewFieldsWithType(tx, view), parsed.data.sort.field)) {
      throw createError({ statusCode: 400, statusMessage: `Records cannot be sorted by "${parsed.data.sort.field}"` })
    }
    // The order set under a record is only a choice on tabs that show it.
    const own = (tab.definition as ViewTabDefinition).sort ?? viewsDefaultSort(tab)
    const sort = parsed.data.sort
    if (sort.field === RECORDS_POSITION_KEY && own?.field !== RECORDS_POSITION_KEY) {
      throw createError({ statusCode: 400, statusMessage: 'This tab has no order of its own' })
    }
    // What the tab shows on its own stores nothing: its sort, or, while nobody
    // has placed a card, the oldest-first order that sort amounts to.
    const same = (a: typeof sort, b: typeof own) => !!b && a.field === b.field && a.dir === b.dir
    const shownByDefault = same(sort, own)
      || (own?.field === RECORDS_POSITION_KEY && same(sort, viewsDefaultSort(tab)) && !(await recordsOrderedUnder(tx, recordId)))
    if (!shownByDefault) choices.sort = sort
  }

  if (Object.keys(choices).length === 0) {
    await tx.deleteFrom('views_record_tabs').where('record_id', '=', recordId).where('tab_id', '=', tab.id).execute()
    return choices
  }
  const definition = sql<Record<string, unknown>>`${JSON.stringify(choices)}::text::jsonb`
  await tx
    .insertInto('views_record_tabs')
    .values({ record_id: recordId, tab_id: tab.id, definition, updated_by: ctx.userId })
    .onConflict(oc => oc.columns(['record_id', 'tab_id']).doUpdateSet({ definition, updated_by: ctx.userId, updated_at: sql`now()` }))
    .execute()
  return choices
}

/** `tab` as its board shows it for the view's record: that record's sort in place of the tab's, while it still applies. */
export async function withRecordTab(
  tx: Tx,
  view: ViewRow,
  tab: ViewTabRow
): Promise<ViewTabRow> {
  if (!SORTED_LAYOUTS.has(tab.layout)) return tab
  const sort = (await readRecordTabs(tx, view, [tab.id])).get(tab.id)?.sort
  return sort ? { ...tab, definition: { ...tab.definition, sort } } : tab
}
