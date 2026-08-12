// GET /api/workflows/views/:id — view meta + definition + the caller's
// access level. 404 for views the caller cannot reach (existence is not
// disclosed).
import { withOrgPermission } from '#tenant/server'
import { requireWorkflowsView, toWorkflowsViewDetail } from '../../../../utils/views'

export default defineEventHandler(async (event) => {
  const viewId = getRouterParam(event, 'id')!
  return await withOrgPermission(event, { appId: 'workflows' }, 'workflows.use', async (tx, ctx) => {
    const { view, access } = await requireWorkflowsView(tx, ctx, viewId, 'view')
    const owner = await tx
      .selectFrom('users')
      .select('display_name')
      .where('id', '=', view.owner_id)
      .executeTakeFirstOrThrow()
    return toWorkflowsViewDetail(view, access, owner.display_name)
  })
})
