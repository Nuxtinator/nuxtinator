// DELETE /api/workflows/views/:id/cards/:recordId — take a record off a
// custom board. View state only; the record itself is untouched.
import { withOrgPermission } from '#tenant/server'
import { requireWorkflowsView } from '../../../../../../utils/views'
import { removeWorkflowsCard } from '../../../../../../utils/placements'

export default defineEventHandler(async (event) => {
  const viewId = getRouterParam(event, 'id')!
  const recordId = getRouterParam(event, 'recordId')!
  return await withOrgPermission(event, { appId: 'workflows' }, 'workflows.use', async (tx, ctx) => {
    const { view } = await requireWorkflowsView(tx, ctx, viewId, 'view')
    await removeWorkflowsCard(tx, view, recordId)
    return { ok: true }
  })
})
