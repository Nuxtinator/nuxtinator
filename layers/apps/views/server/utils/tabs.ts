// Tab edits — every route that changes a view's tabs goes through these.
// Each one needs 'edit' on the view, keeps at least one tab, and bumps the
// view's updated_at so the views list shows recent work first.

import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import { generateNKeysBetween } from 'fractional-indexing'
import type { Database } from '#core/server/database/schema'
import type { ViewsLayout } from '../database/schema'
import {
  listTabs,
  requireTab,
  sanitizeTabDefinition,
  type ViewRow,
  type ViewTabDefinition,
  type ViewTabRow
} from './views'

type Tx = Transaction<Database>

async function touchView(tx: Tx, viewId: string): Promise<void> {
  await tx.updateTable('views_definitions').set({ updated_at: sql`now()` }).where('id', '=', viewId).execute()
}

export interface ViewTabPatch {
  name?: string
  layout?: ViewsLayout
  /** The whole tab definition; replaces the stored one. */
  definition?: unknown
}

// A layout switch keeps what still applies: tables have no grouping, and
// only boards have their own columns.
function adaptToLayout(definition: ViewTabDefinition, layout: ViewsLayout): ViewTabDefinition {
  const next = { ...definition }
  if (layout !== 'kanban') delete next.columns
  if (layout === 'table') delete next.groupField
  return next
}

export async function updateTab(tx: Tx, view: ViewRow, tabId: string, patch: ViewTabPatch): Promise<ViewTabRow> {
  const tab = await requireTab(tx, view, tabId)
  const set: Record<string, unknown> = {}
  if (patch.name !== undefined) set.name = patch.name
  if (patch.layout !== undefined || patch.definition !== undefined) {
    const layout = patch.layout ?? tab.layout
    const raw = patch.definition !== undefined
      ? patch.definition
      : adaptToLayout(tab.definition as ViewTabDefinition, layout)
    const definition = await sanitizeTabDefinition(tx, view, layout, raw)
    set.layout = layout
    // jsonb params bind reliably only through the text cast.
    set.definition = sql`${JSON.stringify(definition)}::text::jsonb`
  }
  if (Object.keys(set).length === 0) throw createError({ statusCode: 400, statusMessage: 'Empty patch' })
  set.updated_at = sql`now()`
  const updated = await tx
    .updateTable('views_tabs')
    .set(set)
    .where('id', '=', tab.id)
    .returningAll()
    .executeTakeFirstOrThrow()
  await touchView(tx, view.id)
  return updated
}

export async function deleteTab(tx: Tx, view: ViewRow, tabId: string): Promise<void> {
  const tab = await requireTab(tx, view, tabId)
  const tabs = await listTabs(tx, view.id)
  if (tabs.length <= 1) throw createError({ statusCode: 409, statusMessage: 'A view keeps at least one tab' })
  await tx.deleteFrom('views_tabs').where('id', '=', tab.id).execute()
  await touchView(tx, view.id)
}

/** Reorders the view's tabs; `tabIds` lists every tab exactly once. */
export async function reorderTabs(tx: Tx, view: ViewRow, tabIds: string[]): Promise<ViewTabRow[]> {
  const tabs = await listTabs(tx, view.id)
  const known = new Set(tabs.map(t => t.id))
  if (tabIds.length !== tabs.length || new Set(tabIds).size !== tabIds.length || !tabIds.every(id => known.has(id))) {
    throw createError({ statusCode: 400, statusMessage: 'tabIds must list every tab of the view once' })
  }
  const keys = generateNKeysBetween(null, null, tabIds.length)
  for (const [i, id] of tabIds.entries()) {
    await tx.updateTable('views_tabs').set({ position: keys[i]! }).where('id', '=', id).execute()
  }
  await touchView(tx, view.id)
  return await listTabs(tx, view.id)
}
