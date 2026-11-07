// POST /api/views/:id/move — a drag landed on a tab (the view's first tab
// when tabId is left out). On field-grouped tabs a drag to another column
// edits the record, so 'view' access is enough and the records kernel's
// update check decides. The order within a column, own columns and an
// ungrouped list's order are view state and need 'edit'.
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { requireTab, requireView } from '../../../../utils/views'
import { moveViewsCard, VIEWS_MOVE_ORDER_MAX } from '../../../../utils/placements'

const Body = z.object({
  tabId: z.string().uuid().optional(),
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
    const { tabId, ...input } = parsed.data
    const { view, access } = await requireView(tx, ctx, viewId, 'view')
    const tab = await requireTab(tx, view, tabId)
    await moveViewsCard(tx, ctx, view, access, tab, input)
    return { ok: true }
  })
})
