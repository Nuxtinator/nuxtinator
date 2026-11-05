// MCP tools for views: list and create views, add and change their tabs
// (board, table or list), set the view's or a tab's filter, read a tab by
// column, add records to a hand-picked view, and move cards. Registered by
// modules/views-mcp.ts only when the MCP layer is loaded.
//
// Every tool takes an optional `org` slug and runs inside
// `withOrgPermission` under the `views.use` scope. View access is the same
// matrix the HTTP routes apply; record reads and writes inside a view are
// still the records kernel's answer (a field-grouped move edits the record,
// so it needs update access to it).
import { z } from 'zod'
import { createError } from 'h3'
import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import { defineMcpTool, type McpToolContext } from '#mcp-layer'
import { withOrgPermission, type TenantContext } from '#tenant/server'
import type { Database } from '#core/server/database/schema'
import { getRecordTypeFields } from '#records/server'
import {
  createView,
  insertTab,
  listViews,
  requireTab,
  requireView,
  sanitizeViewDefinition,
  toTabDetail,
  VIEWS_LAYOUTS,
  type ViewDefinition,
  type ViewRow,
  type ViewTabDefinition,
  type ViewTabRow
} from '../server/utils/views'
import { updateTab } from '../server/utils/tabs'
import { getViewRecords, type ViewRecords } from '../server/utils/view-records'
import { addViewsCard, dragMode, moveViewsCard } from '../server/utils/placements'

type Tx = Transaction<Database>

const orgInput = z.string().min(1).max(64).optional()
  .describe('Org slug to operate in. Defaults to the X-Active-Org header sent by the client.')

const viewIdInput = z.string().uuid().describe('View id, from views_list.')
const tabIdInput = z.string().uuid().optional().describe('Tab id, from views_list or views_get_board. Defaults to the view\'s first tab.')

const FILTER_OPS = [
  'is', 'is_not', 'any_of', 'none_of', 'all_of', 'contains', 'empty', 'not_empty',
  'before', 'after', 'on', 'between', 'eq', 'lt', 'gt'
] as const

const filterRule = z.object({
  field: z.string().min(1).max(80).describe('Field key (see records_list_types), or name, status, created_at, updated_at.'),
  op: z.enum(FILTER_OPS),
  value: z.unknown().optional().describe('One value; a list for any_of / none_of / all_of; [from, to] for between; none for empty / not_empty. "@me" in a people field means whoever is looking.')
}).strict()

const filterInnerGroup = z.object({
  match: z.enum(['all', 'any']),
  rules: z.array(filterRule).max(50)
}).strict()

const filterInput = z.object({
  match: z.enum(['all', 'any']).describe('"all" = every rule must match, "any" = at least one.'),
  rules: z.array(z.union([filterRule, filterInnerGroup])).max(50)
    .describe('Rules, and groups of rules one level deep, e.g. status is open AND (assignee is @me OR assignee is empty).')
}).strict()
  .describe('A filter. Ops by field kind: text contains/is/empty; dropdown is/is_not/any_of/none_of/empty; multi-select and tags any_of/all_of/none_of/empty; people is/any_of/none_of/empty; dates on/before/after/between/empty (YYYY-MM-DD); numbers eq/lt/gt/between/empty; checkbox is; connections any_of/none_of/empty (record ids). Pass { match: "all", rules: [] } to clear it.')

const layoutInput = z.enum(VIEWS_LAYOUTS).describe('kanban = a board of columns, list = rows with a done checkbox, table = a sortable grid.')

function run<T>(
  ctx: McpToolContext,
  org: string | undefined,
  fn: (tx: Tx, tenant: TenantContext) => Promise<T>
): Promise<T> {
  return withOrgPermission(ctx.event, { appId: 'views', org }, 'views.use', fn)
}

function text(message: string, structured: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: message }], structuredContent: structured }
}

function columnsFrom(labels: string[]): Array<{ key: string, label: string }> {
  const used = new Set<string>()
  return labels.map((label) => {
    let key = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'column'
    while (used.has(key)) key = `${key}-2`
    used.add(key)
    return { key, label }
  })
}

interface BoardColumn {
  key: string
  label: string
  cards: Array<{ id: string, name: string }>
}

// The tab's columns (board) or sections (list) with their cards, in the same
// shape the UI shows: custom columns from the definition, one column per
// grouping value with a leading "No value" column, or a single unnamed
// section for an ungrouped list. Manual ranks order cards within a column.
async function boardColumns(tx: Tx, view: ViewRow, tab: ViewTabRow, records: ViewRecords): Promise<BoardColumn[]> {
  const def = tab.definition as ViewTabDefinition
  const rank = new Map(records.placements.filter(p => p.rank).map(p => [`${p.recordId}:${p.columnKey}`, p.rank!]))
  const ordered = (key: string, ids: string[]) => {
    const byId = new Map(records.items.map(i => [i.id, i]))
    return ids
      .map(id => byId.get(id)!)
      .sort((a, b) => {
        const ra = rank.get(`${a.id}:${key}`)
        const rb = rank.get(`${b.id}:${key}`)
        if (ra && rb) return ra < rb ? -1 : ra > rb ? 1 : 0
        return ra ? -1 : rb ? 1 : 0
      })
      .map(i => ({ id: i.id, name: i.name }))
  }

  if (def.columns) {
    const columnOf = new Map(records.placements.map(p => [p.recordId, p.columnKey]))
    const first = def.columns[0]?.key
    const home = (id: string) => {
      const key = columnOf.get(id)
      return key !== undefined && def.columns!.some(c => c.key === key) ? key : first
    }
    return def.columns.map(c => ({
      key: c.key,
      label: c.label,
      cards: ordered(c.key, records.items.filter(i => home(i.id) === c.key).map(i => i.id))
    }))
  }

  if (!def.groupField) {
    return [{ key: '', label: tab.name, cards: ordered('', records.items.map(i => i.id)) }]
  }

  const fields = await getRecordTypeFields(tx, view.record_type_key)
  const field = fields.find(f => f.key === def.groupField)
  const members = new Map<string, string[]>()
  for (const item of records.items) {
    const values = item.groupValues ?? []
    for (const key of values.length > 0 ? values : ['']) {
      members.set(key, [...(members.get(key) ?? []), item.id])
    }
  }
  const labels: Array<{ key: string, label: string }> = [{ key: '', label: `No ${field?.label.toLowerCase() ?? 'value'}` }]
  if (records.groupColumns) labels.push(...records.groupColumns)
  for (const [key, option] of Object.entries(field?.options ?? {})) {
    if (!option.deleted) labels.push({ key, label: option.label })
  }
  for (const key of members.keys()) {
    if (!labels.some(l => l.key === key)) labels.push({ key, label: key })
  }
  return labels.map(l => ({ key: l.key, label: l.label, cards: ordered(l.key, members.get(l.key) ?? []) }))
}

async function groupFieldOf(tx: Tx, view: ViewRow, tab: ViewTabRow) {
  const def = tab.definition as ViewTabDefinition
  if (tab.layout === 'table' || !def.groupField) return null
  const fields = await getRecordTypeFields(tx, view.record_type_key)
  return fields.find(f => f.key === def.groupField && !f.orphan) ?? null
}

async function touchView(tx: Tx, viewId: string): Promise<void> {
  await tx.updateTable('views_definitions').set({ updated_at: sql`now()` }).where('id', '=', viewId).execute()
}

export const listViewsTool = defineMcpTool({
  name: 'views_list',
  title: 'List Views',
  description: 'List the views you can open: your own, ones shared with you or your teams, and org-wide ones, with the record type each shows and its tabs (each tab is a board, list or table).',
  appId: 'views',
  scope: 'views.use',
  readOnly: true,
  input: z.object({ org: orgInput }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, async (tx, tenant) => {
      const views = await listViews(tx, tenant)
      const tabs = views.length === 0
        ? []
        : await tx
            .selectFrom('views_tabs')
            .select(['id', 'view_id', 'name', 'layout'])
            .where('view_id', 'in', views.map(v => v.id))
            .orderBy('position', 'asc')
            .execute()
      return text(`${views.length} view(s)`, {
        views: views.map(v => ({
          id: v.id,
          name: v.name,
          recordType: v.recordTypeKey,
          visibility: v.visibility,
          access: v.accessLevel,
          owner: v.ownerName,
          tabs: tabs.filter(t => t.view_id === v.id).map(t => ({ id: t.id, name: t.name, layout: t.layout }))
        }))
      })
    })
  }
})

export const createViewTool = defineMcpTool({
  name: 'views_create',
  title: 'Create View',
  description: 'Create a view over one record type (see records_list_types) with its first tab. A board groups cards by a field — a dropdown, multi-select, tags, people or connection field (pass groupField) — or has its own columns that you add records to (pass columns; the view then holds only records you add). A list can group into sections by the same kinds of field. A filter here is the view\'s base filter, which every tab narrows further. New views are private; set visibility to "org" to show it to everyone.',
  appId: 'views',
  scope: 'views.use',
  input: z.object({
    org: orgInput,
    name: z.string().trim().min(1).max(120),
    recordType: z.string().min(1).max(80).describe('Record type key, e.g. "task".'),
    layout: layoutInput,
    tabName: z.string().trim().max(80).optional().describe('The first tab\'s name; defaults to Board, List or Table.'),
    groupField: z.string().max(80).optional().describe('Boards and lists: the field whose values make the columns or sections.'),
    columns: z.array(z.string().trim().min(1).max(80)).min(1).max(50).optional().describe('Boards only: column names for a board with its own columns.'),
    cardFields: z.array(z.string().max(80)).max(20).optional().describe('Fields shown on each card, list row or as table columns; defaults to the type\'s card layout.'),
    filter: filterInput.optional(),
    visibility: z.enum(['private', 'org']).optional()
  }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, async (tx, tenant) => {
      const tabDefinition: Record<string, unknown> = {}
      if (input.groupField) tabDefinition.groupField = input.groupField
      if (input.columns) tabDefinition.columns = columnsFrom(input.columns)
      if (input.cardFields) tabDefinition.cardFields = input.cardFields
      const definition: Record<string, unknown> = {}
      if (input.filter) definition.filter = input.filter
      if (input.columns) definition.picked = true
      const view = await createView(tx, tenant, {
        name: input.name,
        recordTypeKey: input.recordType,
        visibility: input.visibility,
        definition,
        tab: { name: input.tabName, layout: input.layout, definition: tabDefinition }
      })
      return text(`Created view ${view.name}.`, {
        view: { id: view.id, name: view.name, recordType: view.recordTypeKey, definition: view.definition, tabs: view.tabs }
      })
    })
  }
})

export const addTabTool = defineMcpTool({
  name: 'views_add_tab',
  title: 'Add Tab',
  description: 'Add a tab to a view: another way of looking at the same records, e.g. "My open tasks" as a list filtered to status open and assignee @me, next to a board by status. The tab\'s filter narrows the view\'s base filter. Needs edit access to the view.',
  appId: 'views',
  scope: 'views.use',
  input: z.object({
    org: orgInput,
    view: viewIdInput,
    name: z.string().trim().min(1).max(80),
    layout: layoutInput,
    groupField: z.string().max(80).optional().describe('Boards and lists: the field whose values make the columns or sections.'),
    columns: z.array(z.string().trim().min(1).max(80)).min(1).max(50).optional().describe('Boards of a view of hand-picked records only: the board\'s own columns.'),
    cardFields: z.array(z.string().max(80)).max(20).optional(),
    sort: z.object({ field: z.string().max(80), dir: z.enum(['asc', 'desc']) }).strict().optional(),
    filter: filterInput.optional()
  }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, async (tx, tenant) => {
      const { view } = await requireView(tx, tenant, input.view, 'edit')
      const definition: Record<string, unknown> = {}
      if (input.groupField) definition.groupField = input.groupField
      if (input.columns) definition.columns = columnsFrom(input.columns)
      if (input.cardFields) definition.cardFields = input.cardFields
      if (input.sort) definition.sort = input.sort
      if (input.filter) definition.filter = input.filter
      const tab = await insertTab(tx, view, { name: input.name, layout: input.layout, definition })
      await touchView(tx, view.id)
      return text(`Added tab ${tab.name}.`, { view: view.id, tab: toTabDetail(tab) })
    })
  }
})

export const updateTabTool = defineMcpTool({
  name: 'views_update_tab',
  title: 'Update Tab',
  description: 'Rename a tab, switch its layout, or change its grouping, card fields or sort. Only the fields you pass change. Use views_set_filter for filters. Needs edit access to the view.',
  appId: 'views',
  scope: 'views.use',
  input: z.object({
    org: orgInput,
    view: viewIdInput,
    tab: z.string().uuid().describe('Tab id, from views_list.'),
    name: z.string().trim().min(1).max(80).optional(),
    layout: layoutInput.optional(),
    groupField: z.string().max(80).nullable().optional().describe('null removes the grouping (lists only).'),
    cardFields: z.array(z.string().max(80)).max(20).nullable().optional().describe('null goes back to the type\'s card layout.'),
    sort: z.object({ field: z.string().max(80), dir: z.enum(['asc', 'desc']) }).strict().nullable().optional()
  }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, async (tx, tenant) => {
      const { view } = await requireView(tx, tenant, input.view, 'edit')
      const tab = await requireTab(tx, view, input.tab)
      const layout = input.layout ?? tab.layout
      const definition: ViewTabDefinition = { ...(tab.definition as ViewTabDefinition) }
      if (layout !== 'kanban') delete definition.columns
      if (layout === 'table') delete definition.groupField
      if (input.groupField !== undefined) {
        if (input.groupField === null) delete definition.groupField
        else definition.groupField = input.groupField
      }
      if (input.cardFields !== undefined) {
        delete definition.cardConnections
        if (input.cardFields === null) delete definition.cardFields
        else definition.cardFields = input.cardFields
      }
      if (input.sort !== undefined) {
        if (input.sort === null) delete definition.sort
        else definition.sort = input.sort
      }
      const updated = await updateTab(tx, view, tab.id, { name: input.name, layout, definition })
      return text(`Updated tab ${updated.name}.`, { view: view.id, tab: toTabDetail(updated) })
    })
  }
})

export const setFilterTool = defineMcpTool({
  name: 'views_set_filter',
  title: 'Set Filter',
  description: 'Replace a filter: the view\'s base filter (no tab), which every tab narrows, or one tab\'s own filter. Needs edit access to the view.',
  appId: 'views',
  scope: 'views.use',
  input: z.object({
    org: orgInput,
    view: viewIdInput,
    tab: z.string().uuid().optional().describe('Tab id; leave out to set the view\'s base filter.'),
    filter: filterInput
  }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, async (tx, tenant) => {
      const { view } = await requireView(tx, tenant, input.view, 'edit')
      if (input.tab) {
        const tab = await requireTab(tx, view, input.tab)
        const definition = { ...(tab.definition as ViewTabDefinition), filter: input.filter }
        const updated = await updateTab(tx, view, tab.id, { definition })
        return text(`Set the filter of tab ${updated.name}.`, { view: view.id, tab: toTabDetail(updated) })
      }
      const current = view.definition as ViewDefinition
      const definition = await sanitizeViewDefinition(tx, view.record_type_key, {
        filter: input.filter,
        ...(current.picked ? { picked: true } : {})
      })
      await tx
        .updateTable('views_definitions')
        .set({ definition: sql`${JSON.stringify(definition)}::text::jsonb`, updated_at: sql`now()` })
        .where('id', '=', view.id)
        .execute()
      return text(`Set the base filter of ${view.name}.`, { view: view.id, definition })
    })
  }
})

export const getBoardTool = defineMcpTool({
  name: 'views_get_board',
  title: 'Get Tab',
  description: 'Read one tab of a view: a board or list column by column (column keys, labels, and the cards in each, in order), or a table\'s rows. Use the column keys with views_move_card.',
  appId: 'views',
  scope: 'views.use',
  readOnly: true,
  input: z.object({ org: orgInput, view: viewIdInput, tab: tabIdInput }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, async (tx, tenant) => {
      const { view } = await requireView(tx, tenant, input.view, 'view')
      const tab = await requireTab(tx, view, input.tab)
      const def = tab.definition as ViewTabDefinition
      const groupField = await groupFieldOf(tx, view, tab)
      if (tab.layout !== 'table' && def.groupField && !groupField) {
        throw createError({ statusCode: 409, statusMessage: 'This tab\'s grouping field no longer exists.' })
      }
      const records = await getViewRecords(tx, tenant, view, tab, groupField, { limit: 100 })
      const tabInfo = { id: tab.id, name: tab.name, layout: tab.layout }
      if (tab.layout === 'table') {
        return text(`${records.items.length} of ${records.total} row(s)`, {
          view: { id: view.id, name: view.name },
          tab: tabInfo,
          rows: records.items.map(i => ({ id: i.id, name: i.name, status: i.status })),
          total: records.total
        })
      }
      const columns = await boardColumns(tx, view, tab, records)
      return text(`${columns.length} column(s)`, {
        view: { id: view.id, name: view.name },
        tab: tabInfo,
        dragMode: groupField ? dragMode(groupField) : 'move',
        columns,
        truncated: records.truncated
      })
    })
  }
})

export const addCardTool = defineMcpTool({
  name: 'views_add_card',
  title: 'Add Card',
  description: 'Add an existing record to a view of hand-picked records (one made with its own columns). Pass a tab and column to put it in a column of a board with its own columns; it otherwise lands in the first column. Views that show every matching record need the record changed instead (records_update).',
  appId: 'views',
  scope: 'views.use',
  input: z.object({
    org: orgInput,
    view: viewIdInput,
    record: z.string().uuid().describe('Record id, from records_search.'),
    tab: tabIdInput,
    column: z.string().max(80).optional().describe('Column key, from views_get_board.')
  }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, async (tx, tenant) => {
      const { view } = await requireView(tx, tenant, input.view, 'view')
      const placement = input.tab || input.column
        ? { tab: await requireTab(tx, view, input.tab), columnKey: input.column }
        : null
      await addViewsCard(tx, tenant, view, input.record, placement)
      return text('Card added.', { view: view.id, record: input.record, column: input.column ?? null })
    })
  }
})

export const moveCardTool = defineMcpTool({
  name: 'views_move_card',
  title: 'Move Card',
  description: 'Move a card to another column of a board or section of a list, at the end. On a tab grouped by a field this changes the record: dropdown and people fields move to the new value; multi-select, tags and connection fields add it and keep the old one (dragMode in views_get_board says which). On a board with its own columns only the card\'s place changes.',
  appId: 'views',
  scope: 'views.use',
  input: z.object({
    org: orgInput,
    view: viewIdInput,
    tab: tabIdInput,
    record: z.string().uuid(),
    fromColumn: z.string().max(80).describe('The column the card is in now ("" for "No value").'),
    toColumn: z.string().max(80).describe('The column to move it to ("" for "No value").')
  }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, async (tx, tenant) => {
      const { view } = await requireView(tx, tenant, input.view, 'view')
      const tab = await requireTab(tx, view, input.tab)
      const groupField = await groupFieldOf(tx, view, tab)
      const records = await getViewRecords(tx, tenant, view, tab, groupField, {})
      const columns = await boardColumns(tx, view, tab, records)
      const target = columns.find(c => c.key === input.toColumn)
      const order = [...(target?.cards.map(c => c.id) ?? []).filter(id => id !== input.record), input.record]
      await moveViewsCard(tx, tenant, view, tab, {
        recordId: input.record,
        fromColumn: input.fromColumn,
        toColumn: input.toColumn,
        columnOrder: order
      })
      return text('Card moved.', { view: view.id, tab: tab.id, record: input.record, toColumn: input.toColumn })
    })
  }
})

export const viewsMcpTools = [
  listViewsTool,
  createViewTool,
  addTabTool,
  updateTabTool,
  setFilterTool,
  getBoardTool,
  addCardTool,
  moveCardTool
]
