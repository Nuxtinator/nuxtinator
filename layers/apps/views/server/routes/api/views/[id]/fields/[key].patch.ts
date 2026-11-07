// PATCH /api/views/:id/fields/:key — renames a field of the view's own or
// replaces its options ({ label?, options?, multiple? }). Its key and kind
// stay. Owner only. Returns the view detail.
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { loadViewDetail, requireView } from '../../../../../utils/views'
import { updateViewField } from '../../../../../utils/view-fields'

const Body = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  options: z.record(z.string(), z.object({ label: z.string().trim().min(1).max(80), color: z.string().max(32).optional() }).strict()).optional(),
  multiple: z.boolean().optional()
}).strict()

export default defineEventHandler(async (event) => {
  const viewId = getRouterParam(event, 'id')!
  const key = getRouterParam(event, 'key')!
  return await withOrgPermission(event, { appId: 'views' }, 'views.use', async (tx, ctx) => {
    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }
    const { view, access, viaShare } = await requireView(tx, ctx, viewId, 'owner')
    const updated = await updateViewField(tx, view, key, parsed.data)
    return await loadViewDetail(tx, updated, access, viaShare)
  })
})
