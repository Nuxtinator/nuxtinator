// GET /api/views/:id — view meta, its definition, its tabs in order, and the
// caller's access level. 404 for views the caller cannot reach (existence is
// not disclosed).
import { withOrgPermission } from '#tenant/server'
import { loadViewDetail, requireView } from '../../../utils/views'

export default defineEventHandler(async (event) => {
  const viewId = getRouterParam(event, 'id')!
  return await withOrgPermission(event, { appId: 'views' }, 'views.use', async (tx, ctx) => {
    const { view, access, viaShare } = await requireView(tx, ctx, viewId, 'view')
    return await loadViewDetail(tx, view, access, viaShare)
  })
})
