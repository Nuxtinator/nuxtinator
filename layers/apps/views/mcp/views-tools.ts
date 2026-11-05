// MCP tools for views: list and create boards and tables, read a board by
// column, put records on a custom board, and move cards. Registered by
// modules/views-mcp.ts only when the MCP layer is loaded.
//
// Every tool takes an optional `org` slug and runs inside
// `withOrgPermission` under the `views.use` scope. View access is the same
// matrix the HTTP routes apply; record reads and writes inside a view are
// still the records kernel's answer (a field-grouped move edits the record,
// so it needs update access to it).
import { z } from 'zod'
import { createError } from 'h3'
import type { Transaction } from 'kysely'
import { defineMcpTool, type McpToolContext } from '#mcp-layer'
import { withOrgPermission, type TenantContext } from '#tenant/server'
import type { Database } from '#core/server/database/schema'
import { getRecordTypeFields } from '#records/server'
import { createView, listViews, requireView, type ViewDefinition, type ViewRow } from '../server/utils/views'
import { getViewRecords, type ViewRecords } from '../server/utils/view-records'
import { addViewsCard, dragMode, moveViewsCard } from '../server/utils/placements'

type Tx = Transaction<Database>

const orgInput = z.string().min(1).max(64).optional()
  .describe('Org slug to operate in. Defaults to the X-Active-Org header sent by the client.')

const viewIdInput = z.string().uuid().describe('View id, from views_list.')

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

interface BoardColumn {
  key: string
  label: string
  cards: Array<{ id: string, name: string }>
}

// The board's columns with their cards, in the same shape the UI shows:
// custom columns from the definition, or one column per grouping value with
// a leading "No value" column. Manual ranks order cards within a column.
async function boardColumns(tx: Tx, view: ViewRow, records: ViewRecords): Promise<BoardColumn[]> {
  const def = view.definition as ViewDefinition
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
    return def.columns.map(c => ({
      key: c.key,
      label: c.label,
      cards: ordered(c.key, records.items.filter(i => columnOf.get(i.id) === c.key).map(i => i.id))
    }))
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

export const listViewsTool = defineMcpTool({
  name: 'views_list',
  title: 'List Views',
  description: 'List the boards and tables you can open: your own, ones shared with you, and org-wide ones, with the record type each shows.',
  appId: 'views',
  scope: 'views.use',
  readOnly: true,
  input: z.object({ org: orgInput }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, async (tx, tenant) => {
      const views = await listViews(tx, tenant)
      return text(`${views.length} view(s)`, {
        views: views.map(v => ({
          id: v.id,
          name: v.name,
          viewType: v.viewType,
          recordType: v.recordTypeKey,
          visibility: v.visibility,
          access: v.accessLevel,
          owner: v.ownerName
        }))
      })
    })
  }
})

export const createViewTool = defineMcpTool({
  name: 'views_create',
  title: 'Create View',
  description: 'Create a kanban board or a table over one record type (see records_list_types). A board groups cards by a field — a dropdown, multi-select, tags, people or connection field (pass groupField) — or has its own columns that you add records to (pass columns). New views are private; set visibility to "org" to show it to everyone.',
  appId: 'views',
  scope: 'views.use',
  input: z.object({
    org: orgInput,
    name: z.string().trim().min(1).max(120),
    recordType: z.string().min(1).max(80).describe('Record type key, e.g. "task".'),
    viewType: z.enum(['kanban', 'table']),
    groupField: z.string().max(80).optional().describe('Boards only: the field whose values make the columns.'),
    columns: z.array(z.string().trim().min(1).max(80)).min(1).max(50).optional().describe('Boards only: column names for a board with its own columns.'),
    cardFields: z.array(z.string().max(80)).max(20).optional().describe('Fields shown on each card or as table columns; defaults to the type\'s card layout.'),
    filters: z.record(z.string(), z.unknown()).optional().describe('Saved filters, keyed by field key (a value for equality, or { in, contains, gte, lte }).'),
    visibility: z.enum(['private', 'shared', 'org']).optional()
  }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, async (tx, tenant) => {
      const definition: Record<string, unknown> = {}
      if (input.groupField) definition.groupField = input.groupField
      if (input.columns) {
        const used = new Set<string>()
        definition.columns = input.columns.map((label) => {
          let key = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'column'
          while (used.has(key)) key = `${key}-2`
          used.add(key)
          return { key, label }
        })
      }
      if (input.cardFields) definition.cardFields = input.cardFields
      if (input.filters) definition.filters = input.filters
      const view = await createView(tx, tenant, {
        name: input.name,
        recordTypeKey: input.recordType,
        viewType: input.viewType,
        visibility: input.visibility,
        definition
      })
      return text(`Created ${view.viewType === 'kanban' ? 'board' : 'table'} ${view.name}.`, {
        view: { id: view.id, name: view.name, viewType: view.viewType, recordType: view.recordTypeKey, definition: view.definition }
      })
    })
  }
})

export const getBoardTool = defineMcpTool({
  name: 'views_get_board',
  title: 'Get Board',
  description: 'Read a board column by column (column keys, labels, and the cards in each, in order), or a table\'s rows. Use the column keys with views_move_card.',
  appId: 'views',
  scope: 'views.use',
  readOnly: true,
  input: z.object({ org: orgInput, view: viewIdInput }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, async (tx, tenant) => {
      const { view } = await requireView(tx, tenant, input.view, 'view')
      const def = view.definition as ViewDefinition
      let groupField = null
      if (def.groupField) {
        const fields = await getRecordTypeFields(tx, view.record_type_key)
        groupField = fields.find(f => f.key === def.groupField && !f.orphan) ?? null
        if (!groupField) throw createError({ statusCode: 409, statusMessage: 'This board\'s grouping field no longer exists.' })
      }
      const records = await getViewRecords(tx, tenant, view, groupField, { limit: 100 })
      if (view.view_type === 'table') {
        return text(`${records.items.length} of ${records.total} row(s)`, {
          rows: records.items.map(i => ({ id: i.id, name: i.name, status: i.status })),
          total: records.total
        })
      }
      const columns = await boardColumns(tx, view, records)
      return text(`${columns.length} column(s)`, {
        view: { id: view.id, name: view.name },
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
  description: 'Put an existing record on a board that has its own columns, at the end of a column. Boards grouped by a field show records by their field values instead; change the record (records_update) to move it onto those.',
  appId: 'views',
  scope: 'views.use',
  input: z.object({
    org: orgInput,
    view: viewIdInput,
    record: z.string().uuid().describe('Record id, from records_search.'),
    column: z.string().max(80).describe('Column key, from views_get_board.')
  }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, async (tx, tenant) => {
      const { view } = await requireView(tx, tenant, input.view, 'view')
      await addViewsCard(tx, tenant, view, input.record, input.column)
      return text('Card added.', { view: view.id, record: input.record, column: input.column })
    })
  }
})

export const moveCardTool = defineMcpTool({
  name: 'views_move_card',
  title: 'Move Card',
  description: 'Move a card to another column, at the end. On a board grouped by a field this changes the record: dropdown and people fields move to the new value; multi-select, tags and connection fields add it and keep the old one (dragMode in views_get_board says which). On a board with its own columns only the card\'s place changes.',
  appId: 'views',
  scope: 'views.use',
  input: z.object({
    org: orgInput,
    view: viewIdInput,
    record: z.string().uuid(),
    fromColumn: z.string().max(80).describe('The column the card is in now ("" for "No value").'),
    toColumn: z.string().max(80).describe('The column to move it to ("" for "No value").')
  }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, async (tx, tenant) => {
      const { view } = await requireView(tx, tenant, input.view, 'view')
      const def = view.definition as ViewDefinition
      let groupField = null
      if (def.groupField) {
        const fields = await getRecordTypeFields(tx, view.record_type_key)
        groupField = fields.find(f => f.key === def.groupField && !f.orphan) ?? null
      }
      const records = await getViewRecords(tx, tenant, view, groupField, {})
      const columns = await boardColumns(tx, view, records)
      const target = columns.find(c => c.key === input.toColumn)
      const order = [...(target?.cards.map(c => c.id) ?? []).filter(id => id !== input.record), input.record]
      await moveViewsCard(tx, tenant, view, {
        recordId: input.record,
        fromColumn: input.fromColumn,
        toColumn: input.toColumn,
        columnOrder: order
      })
      return text('Card moved.', { view: view.id, record: input.record, toColumn: input.toColumn })
    })
  }
})

export const viewsMcpTools = [
  listViewsTool,
  createViewTool,
  getBoardTool,
  addCardTool,
  moveCardTool
]
