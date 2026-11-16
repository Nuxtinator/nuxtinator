// GET /api/views/:id/records?tab=<tabId> — the poll target for one tab (the
// view's first tab when none is named). The view's base filter and the tab's
// filter both apply; ?q= adds a text search and ?sort=&dir= override the
// tab's saved sort for this request. Boards and lists return the whole
// (capped) set plus the tab's placements and per-record grouping values;
// tables page normally (?limit=&offset=); calendars return the records on
// the days ?from=&to= cover plus the first ones with no date. Record
// visibility is the records kernel's — same tab, different callers, possibly
// different records.
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { requireTab, requireView, TIMESTAMP_KEYS, type ViewTabDefinition } from '../../../../utils/views'
import { effectiveCardLayout, getViewRecords, requireRecordsReadScope } from '../../../../utils/view-records'
import { viewFieldsWithType } from '../../../../utils/view-fields'

const Query = z.object({
  tab: z.string().uuid().optional(),
  q: z.string().optional(),
  sort: z.string().optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
})

export default defineEventHandler(async (event) => {
  const viewId = getRouterParam(event, 'id')!
  return await withOrgPermission(event, { appId: 'views' }, 'views.use', async (tx, ctx) => {
    requireRecordsReadScope(ctx)
    const { view } = await requireView(tx, ctx, viewId, 'view')

    const parsed = Query.safeParse(getQuery(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid query', data: parsed.error.flatten() })
    }
    const tab = await requireTab(tx, view, parsed.data.tab)

    const definition = tab.definition as ViewTabDefinition
    if (tab.layout === 'calendar' && definition.dateField && !TIMESTAMP_KEYS.has(definition.dateField)) {
      const fields = await viewFieldsWithType(tx, view)
      if (!fields.some(f => f.key === definition.dateField && !f.orphan)) {
        const card = await effectiveCardLayout(tx, view, tab)
        return { tabId: tab.id, items: [], total: 0, truncated: false, placements: [], card, groupFieldMissing: false, dateFieldMissing: true }
      }
    }
    let groupFieldDef = null
    if (tab.layout !== 'table' && definition.groupField) {
      const fields = await viewFieldsWithType(tx, view)
      groupFieldDef = fields.find(f => f.key === definition.groupField && !f.orphan) ?? null
      if (!groupFieldDef) {
        // The grouping field was deleted (from the type or the view): the client renders
        // the explicit "grouping field missing" state off this marker.
        const card = await effectiveCardLayout(tx, view, tab)
        return { tabId: tab.id, items: [], total: 0, truncated: false, placements: [], card, groupFieldMissing: true }
      }
    }

    const result = await getViewRecords(tx, ctx, view, tab, groupFieldDef, {
      q: parsed.data.q,
      sort: parsed.data.sort,
      dir: parsed.data.dir,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
      from: parsed.data.from,
      to: parsed.data.to
    })
    return { tabId: tab.id, ...result, groupFieldMissing: false }
  })
})
