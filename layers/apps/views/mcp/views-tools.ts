// MCP tools for views: list and create views, add and change their tabs
// (board, table or list), set the view's or a tab's filter, read a tab by
// column, add or create records on a hand-picked view, move cards, and manage
// and fill in the view's own fields. Registered by modules/views-mcp.ts only
// when the MCP layer is loaded.
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
import { listBuiltInViews } from '../server/utils/builtin-views'
import { getViewRecords, requireRecordsReadScope, requireRecordsWriteScope, type ViewRecords } from '../server/utils/view-records'
import { addViewsCard, assertInView, createViewsCard, dragMode, moveViewsCard } from '../server/utils/placements'
import {
  addViewField,
  deleteViewField,
  readViewValues,
  setViewValues,
  updateViewField,
  VIEW_FIELD_KINDS,
  viewFieldsOf,
  viewFieldsWithType
} from '../server/utils/view-fields'

type Tx = Transaction<Database>

const orgInput = z.string().min(1).max(64).optional()
  .describe('Org slug to operate in. Defaults to the X-Active-Org header sent by the client.')

const viewIdInput = z.union([z.string().uuid(), z.string().regex(/^builtin\.[A-Za-z0-9.-]{1,140}$/)])
  .describe('View id, from views_list.')
const tabIdInput = z.string().uuid().optional().describe('Tab id, from views_list or views_get_board. Defaults to the view\'s first tab.')

const FILTER_OPS = [
  'is', 'is_not', 'any_of', 'none_of', 'all_of', 'contains', 'empty', 'not_empty',
  'before', 'after', 'on', 'between', 'eq', 'lt', 'gt'
] as const

const filterRule = z.object({
  field: z.string().min(1).max(80).describe('Field key (see records_list_types, and views_list_fields for the view\'s own), or name, status, created_at, updated_at.'),
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

const shareInput = z.boolean().optional()
  .describe('Set true to assign someone who can\'t see the card yet; doing so shares it with them. Without it the call is refused and names those people, so confirm with the user first.')

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
  cards: Array<{ id: string, name: string, values?: Record<string, unknown> }>
}

// The tab's columns (board) or sections (list) with their cards, in the same
// shape the UI shows: custom columns from the definition (after a leading
// "No column" lane when the view isn't hand-picked), one column per grouping
// value with a leading "No value" column, or a single unnamed section for an
// ungrouped list. Manual ranks order cards within a column.
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
      .map(i => (i.viewValues ? { id: i.id, name: i.name, values: i.viewValues } : { id: i.id, name: i.name }))
  }

  if (def.columns) {
    const columnOf = new Map(records.placements.map(p => [p.recordId, p.columnKey]))
    const picked = !!(view.definition as ViewDefinition).picked
    const lanes = picked ? def.columns : [{ key: '', label: 'No column' }, ...def.columns]
    const fallback = lanes[0]?.key
    const home = (id: string) => {
      const key = columnOf.get(id)
      return key !== undefined && lanes.some(c => c.key === key) ? key : fallback
    }
    return lanes.map(c => ({
      key: c.key,
      label: c.label,
      cards: ordered(c.key, records.items.filter(i => home(i.id) === c.key).map(i => i.id))
    }))
  }

  if (!def.groupField) {
    return [{ key: '', label: tab.name, cards: ordered('', records.items.map(i => i.id)) }]
  }

  const fields = await viewFieldsWithType(tx, view)
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
  const fields = await viewFieldsWithType(tx, view)
  return fields.find(f => f.key === def.groupField && !f.orphan) ?? null
}

async function touchView(tx: Tx, viewId: string): Promise<void> {
  await tx.updateTable('views_definitions').set({ updated_at: sql`now()` }).where('id', '=', viewId).execute()
}

export const listViewsTool = defineMcpTool({
  name: 'views_list',
  title: 'List Views',
  description: 'List the views you can open: built-in ones everyone has (such as My tasks, which nobody can change), your own, ones shared with you or your teams, and org-wide ones, with the record type each shows and its tabs (each tab is a board, list or table).',
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
      const builtIns = await listBuiltInViews(tx, tenant)
      return text(`${views.length + builtIns.length} view(s)`, {
        views: [
          ...builtIns.map(b => ({
            id: b.id,
            name: b.view.name,
            recordType: b.view.record_type_key,
            builtIn: true,
            access: 'view',
            tabs: b.tabs.map(t => ({ id: t.id, name: t.name, layout: t.layout }))
          })),
          ...views.map(v => ({
            id: v.id,
            name: v.name,
            recordType: v.recordTypeKey,
            visibility: v.visibility,
            access: v.accessLevel,
            owner: v.ownerName,
            tabs: tabs.filter(t => t.view_id === v.id).map(t => ({ id: t.id, name: t.name, layout: t.layout }))
          }))
        ]
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
    columns: z.array(z.string().trim().min(1).max(80)).max(50).optional().describe('Boards only, instead of groupField: the board\'s own columns. Moving a card between them never changes the record. In a view that shows every matching record, cards start in a "No column" lane (key ""), and [] gives a board with just that lane; a view of hand-picked records needs at least one column.'),
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
  description: 'Replace a filter: the view\'s base filter (no tab), which every tab narrows, or one tab\'s own filter. The base filter needs owner access to the view; a tab\'s filter needs edit access.',
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
      const { view } = await requireView(tx, tenant, input.view, input.tab ? 'edit' : 'owner')
      if (input.tab) {
        const tab = await requireTab(tx, view, input.tab)
        const definition = { ...(tab.definition as ViewTabDefinition), filter: input.filter }
        const updated = await updateTab(tx, view, tab.id, { definition })
        return text(`Set the filter of tab ${updated.name}.`, { view: view.id, tab: toTabDetail(updated) })
      }
      const current = view.definition as ViewDefinition
      const definition = await sanitizeViewDefinition(tx, view.record_type_key, {
        filter: input.filter,
        ...(current.picked ? { picked: true } : {}),
        ...(current.fields ? { fields: current.fields } : {})
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
      requireRecordsReadScope(tenant)
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
          view: { id: input.view, name: view.name },
          tab: tabInfo,
          rows: records.items.map(i => ({ id: i.id, name: i.name, status: i.status, ...(i.viewValues ? { values: i.viewValues } : {}) })),
          total: records.total
        })
      }
      const columns = await boardColumns(tx, view, tab, records)
      return text(`${columns.length} column(s)`, {
        view: { id: input.view, name: view.name },
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
      const { view } = await requireView(tx, tenant, input.view, 'edit')
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
    fromColumn: z.string().max(80).describe('The column the card is in now ("" for "No value" or "No column").'),
    toColumn: z.string().max(80).describe('The column to move it to ("" for "No value" or "No column").'),
    share: shareInput
  }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, async (tx, tenant) => {
      const { view, access } = await requireView(tx, tenant, input.view, 'view')
      const tab = await requireTab(tx, view, input.tab)
      const groupField = await groupFieldOf(tx, view, tab)
      const records = await getViewRecords(tx, tenant, view, tab, groupField, {})
      const columns = await boardColumns(tx, view, tab, records)
      const target = columns.find(c => c.key === input.toColumn)
      const order = [...(target?.cards.map(c => c.id) ?? []).filter(id => id !== input.record), input.record]
      await moveViewsCard(tx, tenant, view, access, tab, {
        recordId: input.record,
        fromColumn: input.fromColumn,
        toColumn: input.toColumn,
        columnOrder: order,
        confirmShare: input.share
      })
      return text('Card moved.', { view: input.view, tab: tab.id, record: input.record, toColumn: input.toColumn })
    })
  }
})

export const createCardTool = defineMcpTool({
  name: 'views_create_card',
  title: 'Create Card',
  description: 'Create a record as one of a hand-picked view\'s own cards (a view made with its own columns), with values for the record\'s fields (`fields`, name required) and for the view\'s own fields (`values`, keys from views_list_fields). Pass a tab and column to land it in a column. Needs edit access to the view and create access to the record type.',
  appId: 'views',
  scope: 'views.use',
  input: z.object({
    org: orgInput,
    view: viewIdInput,
    fields: z.record(z.string(), z.unknown()).describe('The record\'s field values; fields.name is required.'),
    values: z.record(z.string(), z.unknown()).optional().describe('Values of the view\'s own fields.'),
    tab: tabIdInput,
    column: z.string().max(80).optional().describe('Column key, from views_get_board.'),
    share: shareInput
  }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, async (tx, tenant) => {
      const { view } = await requireView(tx, tenant, input.view, 'edit')
      const placement = input.tab || input.column
        ? { tab: await requireTab(tx, view, input.tab), columnKey: input.column }
        : null
      const card = await createViewsCard(tx, tenant, view, input.fields, placement, {
        viewValues: input.values,
        sharing: input.share ? 'confirmed' : 'ask'
      })
      return text('Card created.', { view: view.id, record: card.id })
    })
  }
})

const fieldOptionsInput = z.array(z.string().trim().min(1).max(80)).min(1).max(50)
  .describe('Dropdown and multi-select fields: the choices, in order.')

function optionsFrom(labels: string[]): Record<string, { label: string }> {
  return Object.fromEntries(columnsFrom(labels).map(c => [c.key, { label: c.label }]))
}

export const listFieldsTool = defineMcpTool({
  name: 'views_list_fields',
  title: 'List View Fields',
  description: 'List a view\'s own fields: fields that belong to the view rather than the record type, with values shared by everyone who opens the view. Filters, sorts, grouping and card fields use their keys like any field.',
  appId: 'views',
  scope: 'views.use',
  readOnly: true,
  input: z.object({ org: orgInput, view: viewIdInput }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, async (tx, tenant) => {
      const { view } = await requireView(tx, tenant, input.view, 'view')
      const fields = viewFieldsOf(view)
      return text(`${fields.length} field(s)`, { view: input.view, fields })
    })
  }
})

export const addFieldTool = defineMcpTool({
  name: 'views_add_field',
  title: 'Add View Field',
  description: 'Add a field of the view\'s own, e.g. "Oven temp" (number) or "Rating" (dropdown) on a pizza board, when the record type lacks it and only this view needs it. A people field here only records who\'s involved; it never shares a card. Only the view\'s owner adds fields.',
  appId: 'views',
  scope: 'views.use',
  input: z.object({
    org: orgInput,
    view: viewIdInput,
    label: z.string().trim().min(1).max(80),
    kind: z.enum(VIEW_FIELD_KINDS).describe('text, textarea, number, boolean, date, key_select (dropdown), multi_select, tags, link, user_select (people), attachments (files).'),
    options: fieldOptionsInput.optional(),
    multiple: z.boolean().optional().describe('People fields: several people.')
  }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, async (tx, tenant) => {
      const { view } = await requireView(tx, tenant, input.view, 'owner')
      const { field } = await addViewField(tx, view, {
        label: input.label,
        kind: input.kind,
        options: input.options ? optionsFrom(input.options) : undefined,
        multiple: input.multiple
      })
      return text(`Added field ${field.label} (${field.key}).`, { view: view.id, field })
    })
  }
})

export const updateFieldTool = defineMcpTool({
  name: 'views_update_field',
  title: 'Update View Field',
  description: 'Rename one of the view\'s own fields or replace its choices. Its kind and key don\'t change. Only the view\'s owner changes fields.',
  appId: 'views',
  scope: 'views.use',
  input: z.object({
    org: orgInput,
    view: viewIdInput,
    field: z.string().max(80).describe('Field key, from views_list_fields.'),
    label: z.string().trim().min(1).max(80).optional(),
    options: fieldOptionsInput.optional()
  }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, async (tx, tenant) => {
      const { view } = await requireView(tx, tenant, input.view, 'owner')
      const current = viewFieldsOf(view).find(f => f.key === input.field)
      let options: Record<string, { label: string }> | undefined
      if (input.options) {
        // Choices whose label is unchanged keep their key, so stored values still match.
        const byLabel = new Map(Object.entries(current?.options ?? {}).map(([key, o]) => [o.label, key]))
        const fresh = optionsFrom(input.options)
        options = {}
        for (const [key, o] of Object.entries(fresh)) options[byLabel.get(o.label) ?? key] = o
      }
      const updated = await updateViewField(tx, view, input.field, { label: input.label, options })
      return text('Field updated.', { view: view.id, fields: viewFieldsOf(updated) })
    })
  }
})

export const deleteFieldTool = defineMcpTool({
  name: 'views_delete_field',
  title: 'Delete View Field',
  description: 'Delete one of the view\'s own fields with every value filled in on it. Only the view\'s owner deletes fields; confirm with the user first.',
  appId: 'views',
  scope: 'views.use',
  input: z.object({
    org: orgInput,
    view: viewIdInput,
    field: z.string().max(80).describe('Field key, from views_list_fields.')
  }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, async (tx, tenant) => {
      const { view } = await requireView(tx, tenant, input.view, 'owner')
      const updated = await deleteViewField(tx, view, input.field)
      return text('Field deleted.', { view: view.id, fields: viewFieldsOf(updated) })
    })
  }
})

export const setValuesTool = defineMcpTool({
  name: 'views_set_values',
  title: 'Set View Values',
  description: 'Fill in the view\'s own fields on one of its cards: { <fieldKey>: value }, null to clear. Dropdowns take a choice key, multi-selects and tags a list, people a user id (or a list), links a list of URLs. Files are added in the app. Needs edit access to the view.',
  appId: 'views',
  scope: 'views.use',
  input: z.object({
    org: orgInput,
    view: viewIdInput,
    record: z.string().uuid().describe('Record id of a card on the view.'),
    values: z.record(z.string(), z.unknown())
  }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, async (tx, tenant) => {
      requireRecordsWriteScope(tenant)
      const { view } = await requireView(tx, tenant, input.view, 'edit')
      await assertInView(tx, tenant, view, input.record)
      await setViewValues(tx, tenant, view, input.record, input.values)
      const values = (await readViewValues(tx, view, [input.record])).get(input.record) ?? {}
      return text('Values saved.', { view: view.id, record: input.record, values })
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
  createCardTool,
  moveCardTool,
  listFieldsTool,
  addFieldTool,
  updateFieldTool,
  deleteFieldTool,
  setValuesTool
]
