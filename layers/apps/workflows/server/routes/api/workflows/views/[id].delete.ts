// DELETE /api/workflows/views/:id — owner only (the host admin role counts
// as owner). Shares and card placements go with it via FK cascade.
import { withOrgPermission } from '#tenant/server'
import { requireWorkflowsView } from '../../../../utils/views'

export default defineEventHandler(async (event) => {
  const viewId = getRouterParam(event, 'id')!
  return await withOrgPermission(event, { appId: 'workflows' }, 'workflows.use', async (tx, ctx) => {
    await requireWorkflowsView(tx, ctx, viewId, 'owner')
    await tx.deleteFrom('workflows_views').where('id', '=', viewId).execute()
    return { ok: true }
  })
})
