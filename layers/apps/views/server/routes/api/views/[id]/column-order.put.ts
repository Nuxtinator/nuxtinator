// PUT /api/views/:id/column-order — places one column of the view's boards
// and lists grouped by `field`: { field, key, order }, with `order` every
// column's key as shown after the drag ("No value" left out). The order holds
// for every tab of the view grouped by that field. Needs 'edit' on the view;
// on the board of a card's tasks, edit access to the card. Returns
// { field, positions }.
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { requireView } from '../../../../utils/views'
import { placeViewColumn, VIEWS_COLUMN_ORDER_MAX } from '../../../../utils/column-order'

const Body = z.object({
  field: z.string().min(1).max(80),
  key: z.string().max(80),
  order: z.array(z.string().max(80)).min(1).max(VIEWS_COLUMN_ORDER_MAX + 1)
}).strict()

export default defineEventHandler(async (event) => {
  const viewId = getRouterParam(event, 'id')!
  return await withOrgPermission(event, { appId: 'views' }, 'views.use', async (tx, ctx) => {
    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }
    const { view, access } = await requireView(tx, ctx, viewId, 'view')
    const positions = await placeViewColumn(tx, ctx, view, access, parsed.data)
    return { field: parsed.data.field, positions }
  })
})
