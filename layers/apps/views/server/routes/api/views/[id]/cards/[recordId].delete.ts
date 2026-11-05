// DELETE /api/views/:id/cards/:recordId — take a record out of a
// hand-picked view, off every tab. View state only; the record itself is
// untouched.
import { withOrgPermission } from '#tenant/server'
import { requireView } from '../../../../../utils/views'
import { removeViewsCard } from '../../../../../utils/placements'

export default defineEventHandler(async (event) => {
  const viewId = getRouterParam(event, 'id')!
  const recordId = getRouterParam(event, 'recordId')!
  return await withOrgPermission(event, { appId: 'views' }, 'views.use', async (tx, ctx) => {
    const { view } = await requireView(tx, ctx, viewId, 'view')
    await removeViewsCard(tx, view, recordId)
    return { ok: true }
  })
})
