// DELETE /api/views/:id — owner only (the host admin role counts
// as owner). Shares and card placements go with it via FK cascade.
import { withOrgPermission } from '#tenant/server'
import { requireView } from '../../../utils/views'

export default defineEventHandler(async (event) => {
  const viewId = getRouterParam(event, 'id')!
  return await withOrgPermission(event, { appId: 'views' }, 'views.use', async (tx, ctx) => {
    await requireView(tx, ctx, viewId, 'owner')
    await tx.deleteFrom('views_definitions').where('id', '=', viewId).execute()
    return { ok: true }
  })
})
