// POST /api/views/:id/cards — put an existing record on a custom
// board ({ recordId, columnKey }), appended at the column's end. Quick-add
// creates the record through CRM's normal create route first, then lands
// here. Field-grouped boards have no membership to manage — 400.
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { requireView } from '../../../../utils/views'
import { addViewsCard } from '../../../../utils/placements'

const Body = z.object({
  recordId: z.string().uuid(),
  columnKey: z.string().min(1).max(80)
}).strict()

export default defineEventHandler(async (event) => {
  const viewId = getRouterParam(event, 'id')!
  return await withOrgPermission(event, { appId: 'views' }, 'views.use', async (tx, ctx) => {
    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }
    const { view } = await requireView(tx, ctx, viewId, 'view')
    await addViewsCard(tx, ctx, view, parsed.data.recordId, parsed.data.columnKey)
    return { ok: true }
  })
})
