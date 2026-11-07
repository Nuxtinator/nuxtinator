// DELETE /api/views/:id/tabs/:tabId — remove a tab and its card positions.
// Needs 'edit'; the last tab of a view can't go (409).
import { withOrgPermission } from '#tenant/server'
import { requireView } from '../../../../../utils/views'
import { deleteTab } from '../../../../../utils/tabs'

export default defineEventHandler(async (event) => {
  const viewId = getRouterParam(event, 'id')!
  const tabId = getRouterParam(event, 'tabId')!
  return await withOrgPermission(event, { appId: 'views' }, 'views.use', async (tx, ctx) => {
    const { view } = await requireView(tx, ctx, viewId, 'edit')
    await deleteTab(tx, view, tabId)
    return { ok: true }
  })
})
