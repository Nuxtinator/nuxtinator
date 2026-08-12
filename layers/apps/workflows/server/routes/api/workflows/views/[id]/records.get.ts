// GET /api/workflows/views/:id/records — the poll target. Query params are
// the caller's *personal* overlay (?filters=<json>&q=&sort=&dir=&limit=&offset=),
// merged over the view's saved filters per key. Kanban returns the whole
// (capped) card set plus placements and per-record grouping values; table
// pages normally. Record visibility is CRM's — same view, different callers,
// possibly different cards.
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { getRecordTypeFields } from '#crm/server'
import { requireWorkflowsView } from '../../../../../utils/views'
import { getWorkflowsViewRecords } from '../../../../../utils/view-records'
import type { WorkflowsViewDefinition } from '../../../../../utils/views'

const Query = z.object({
  q: z.string().optional(),
  sort: z.string().optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  filters: z.string().optional()
})

const Filters = z.record(z.string(), z.unknown())

export default defineEventHandler(async (event) => {
  const viewId = getRouterParam(event, 'id')!
  return await withOrgPermission(event, { appId: 'workflows' }, 'workflows.use', async (tx, ctx) => {
    const { view } = await requireWorkflowsView(tx, ctx, viewId, 'view')

    const parsed = Query.safeParse(getQuery(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid query', data: parsed.error.flatten() })
    }
    let filters: Record<string, unknown> | undefined
    if (parsed.data.filters) {
      let raw: unknown
      try {
        raw = JSON.parse(parsed.data.filters)
      } catch {
        throw createError({ statusCode: 400, statusMessage: 'filters must be a JSON object' })
      }
      const parsedFilters = Filters.safeParse(raw)
      if (!parsedFilters.success) {
        throw createError({ statusCode: 400, statusMessage: 'filters must be a JSON object' })
      }
      filters = parsedFilters.data
    }

    const definition = view.definition as WorkflowsViewDefinition
    let groupFieldDef = null
    if (view.view_type === 'kanban' && definition.groupField) {
      const fields = await getRecordTypeFields(tx, view.record_type_key)
      groupFieldDef = fields.find(f => f.key === definition.groupField && !f.orphan) ?? null
      if (!groupFieldDef) {
        // The grouping field was deleted from the type: the client renders
        // the explicit "grouping field missing" state off this marker.
        return { items: [], total: 0, truncated: false, placements: [], groupFieldMissing: true }
      }
    }

    const result = await getWorkflowsViewRecords(tx, ctx, view, groupFieldDef, {
      filters,
      q: parsed.data.q,
      sort: parsed.data.sort,
      dir: parsed.data.dir,
      limit: parsed.data.limit,
      offset: parsed.data.offset
    })
    return { ...result, groupFieldMissing: false }
  })
})
