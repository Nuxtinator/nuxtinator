// POST /api/views/:id/cards — add an existing record to a hand-picked view
// ({ recordId, tabId?, columnKey? }). With a tab it also lands at the end of
// that tab's column (a board with its own columns) or list. Quick-add creates
// the record through the records create route first, then lands here. Views
// that show every matching record have nothing to add — 400.
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { requireTab, requireView } from '../../../../utils/views'
import { addViewsCard } from '../../../../utils/placements'

const Body = z.object({
  recordId: z.string().uuid(),
  tabId: z.string().uuid().optional(),
  columnKey: z.string().min(1).max(80).optional()
}).strict()

export default defineEventHandler(async (event) => {
  const viewId = getRouterParam(event, 'id')!
  return await withOrgPermission(event, { appId: 'views' }, 'views.use', async (tx, ctx) => {
    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }
    const { view } = await requireView(tx, ctx, viewId, 'view')
    const { recordId, tabId, columnKey } = parsed.data
    const placement = tabId || columnKey
      ? { tab: await requireTab(tx, view, tabId), columnKey }
      : null
    await addViewsCard(tx, ctx, view, recordId, placement)
    return { ok: true }
  })
})
