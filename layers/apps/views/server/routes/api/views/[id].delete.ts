// DELETE /api/views/:id — owner only (the host admin role counts
// as owner). The records created on a hand-picked view that no other view
// holds are deleted with it; shares and card placements go via FK cascade.
import { withOrgPermission } from '#tenant/server'
import { deleteViewWithOwnCards, requireView } from '../../../utils/views'

export default defineEventHandler(async (event) => {
  const viewId = getRouterParam(event, 'id')!
  return await withOrgPermission(event, { appId: 'views' }, 'views.use', async (tx, ctx) => {
    const { view } = await requireView(tx, ctx, viewId, 'owner')
    await deleteViewWithOwnCards(tx, view)
    return { ok: true }
  })
})
