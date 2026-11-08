// DELETE /api/views/:id/fields/:key — deletes a field of the view's own with
// every value and file on it, and takes it out of the view's filters, card
// fields and sorts. Owner only. Returns the view detail.
import { withOrgPermission } from '#tenant/server'
import { loadViewDetail, requireView } from '../../../../../utils/views'
import { deleteViewField } from '../../../../../utils/view-fields'

export default defineEventHandler(async (event) => {
  const viewId = getRouterParam(event, 'id')!
  const key = getRouterParam(event, 'key')!
  return await withOrgPermission(event, { appId: 'views' }, 'views.use', async (tx, ctx) => {
    const { view, access, viaShare } = await requireView(tx, ctx, viewId, 'owner')
    const updated = await deleteViewField(tx, view, key)
    return await loadViewDetail(tx, updated, access, viaShare)
  })
})
