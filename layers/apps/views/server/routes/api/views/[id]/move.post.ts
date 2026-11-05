// POST /api/views/:id/move — a drag landed. 'view' access is
// enough to move cards (Trello-loose); on field-grouped boards the record
// write itself still goes through CRM's update permission, so a caller who
// may not edit the record gets a 403 from that check, not from the view.
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { requireView } from '../../../../utils/views'
import { moveViewsCard, VIEWS_MOVE_ORDER_MAX } from '../../../../utils/placements'

const Body = z.object({
  recordId: z.string().uuid(),
  fromColumn: z.string().max(80).nullable(),
  toColumn: z.string().max(80),
  columnOrder: z.array(z.string().uuid()).min(1).max(VIEWS_MOVE_ORDER_MAX)
}).strict()

export default defineEventHandler(async (event) => {
  const viewId = getRouterParam(event, 'id')!
  return await withOrgPermission(event, { appId: 'views' }, 'views.use', async (tx, ctx) => {
    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }
    const { view } = await requireView(tx, ctx, viewId, 'view')
    await moveViewsCard(tx, ctx, view, parsed.data)
    return { ok: true }
  })
})
