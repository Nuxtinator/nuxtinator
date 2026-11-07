// POST /api/views/:id/fields — adds a field of the view's own:
// { label, kind, options? (select kinds), multiple? (people) }. Its key is
// made from the label. Owner only. Returns { view, field }.
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { loadViewDetail, requireView } from '../../../../utils/views'
import { addViewField, VIEW_FIELD_KINDS } from '../../../../utils/view-fields'

const Body = z.object({
  label: z.string().trim().min(1).max(80),
  kind: z.enum(VIEW_FIELD_KINDS),
  options: z.record(z.string(), z.object({ label: z.string().trim().min(1).max(80), color: z.string().max(32).optional() }).strict()).optional(),
  multiple: z.boolean().optional()
}).strict()

export default defineEventHandler(async (event) => {
  const viewId = getRouterParam(event, 'id')!
  return await withOrgPermission(event, { appId: 'views' }, 'views.use', async (tx, ctx) => {
    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }
    const { view, access, viaShare } = await requireView(tx, ctx, viewId, 'owner')
    const added = await addViewField(tx, view, parsed.data)
    return { view: await loadViewDetail(tx, added.view, access, viaShare), field: added.field }
  })
})
