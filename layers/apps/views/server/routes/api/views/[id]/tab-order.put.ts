// PUT /api/views/:id/tab-order — { tabIds } in their new order, every tab
// once. Needs 'edit'. Returns the tabs in order.
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { requireView, toTabDetail } from '../../../../utils/views'
import { reorderTabs } from '../../../../utils/tabs'

const Body = z.object({ tabIds: z.array(z.string().uuid()).min(1).max(50) }).strict()

export default defineEventHandler(async (event) => {
  const viewId = getRouterParam(event, 'id')!
  return await withOrgPermission(event, { appId: 'views' }, 'views.use', async (tx, ctx) => {
    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }
    const { view } = await requireView(tx, ctx, viewId, 'edit')
    return { tabs: (await reorderTabs(tx, view, parsed.data.tabIds)).map(toTabDetail) }
  })
})
