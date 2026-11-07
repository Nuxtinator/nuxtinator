// PATCH /api/views/:id/tabs/:tabId — rename a tab, switch its layout, or
// replace its definition (grouping or columns, card fields, sort, filter).
// Needs 'edit'. A layout switch without a definition keeps what still applies.
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { requireView, toTabDetail, VIEWS_LAYOUTS } from '../../../../../utils/views'
import { updateTab } from '../../../../../utils/tabs'

const Body = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  layout: z.enum(VIEWS_LAYOUTS).optional(),
  definition: z.unknown().optional()
}).strict()

export default defineEventHandler(async (event) => {
  const viewId = getRouterParam(event, 'id')!
  const tabId = getRouterParam(event, 'tabId')!
  return await withOrgPermission(event, { appId: 'views' }, 'views.use', async (tx, ctx) => {
    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }
    const { view } = await requireView(tx, ctx, viewId, 'edit')
    return toTabDetail(await updateTab(tx, view, tabId, parsed.data))
  })
})
