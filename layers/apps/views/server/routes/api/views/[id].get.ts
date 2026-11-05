// GET /api/views/:id — view meta + definition + the caller's
// access level. 404 for views the caller cannot reach (existence is not
// disclosed).
import { withOrgPermission } from '#tenant/server'
import { requireView, toViewDetail } from '../../../utils/views'

export default defineEventHandler(async (event) => {
  const viewId = getRouterParam(event, 'id')!
  return await withOrgPermission(event, { appId: 'views' }, 'views.use', async (tx, ctx) => {
    const { view, access, viaShare } = await requireView(tx, ctx, viewId, 'view')
    const owner = await tx
      .selectFrom('users')
      .select('display_name')
      .where('id', '=', view.owner_id)
      .executeTakeFirstOrThrow()
    return toViewDetail(view, access, owner.display_name, viaShare)
  })
})
