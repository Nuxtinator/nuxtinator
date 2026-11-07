// GET /api/views/:id/records?tab=<tabId> — the poll target for one tab (the
// view's first tab when none is named). The view's base filter and the tab's
// filter both apply; ?q= adds a text search and ?sort=&dir= override the
// tab's saved sort for this request. Boards and lists return the whole
// (capped) set plus the tab's placements and per-record grouping values;
// tables page normally (?limit=&offset=). Record visibility is the records
// kernel's — same tab, different callers, possibly different records.
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { getRecordTypeFields } from '#records/server'
import { requireTab, requireView, type ViewTabDefinition } from '../../../../utils/views'
import { effectiveCardLayout, getViewRecords, requireRecordsReadScope } from '../../../../utils/view-records'

const Query = z.object({
  tab: z.string().uuid().optional(),
  q: z.string().optional(),
  sort: z.string().optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional()
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
    let groupFieldDef = null
    if (tab.layout !== 'table' && definition.groupField) {
      const fields = await getRecordTypeFields(tx, view.record_type_key)
      groupFieldDef = fields.find(f => f.key === definition.groupField && !f.orphan) ?? null
      if (!groupFieldDef) {
        // The grouping field was deleted from the type: the client renders
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
      offset: parsed.data.offset
    })
    return { tabId: tab.id, ...result, groupFieldMissing: false }
  })
})
