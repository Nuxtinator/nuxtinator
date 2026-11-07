// DELETE /api/views/:id/cards/:recordId — take a record out of a
// hand-picked view, off every tab; the record itself is untouched. With
// ?record=delete the record is deleted instead (see deleteViewsCardRecord
// for which records that covers). Needs 'edit' on the view.
import { withOrgPermission } from '#tenant/server'
import { requireView } from '../../../../../utils/views'
import { deleteViewsCardRecord, removeViewsCard } from '../../../../../utils/placements'

export default defineEventHandler(async (event) => {
  const viewId = getRouterParam(event, 'id')!
  const recordId = getRouterParam(event, 'recordId')!
  return await withOrgPermission(event, { appId: 'views' }, 'views.use', async (tx, ctx) => {
    const { view } = await requireView(tx, ctx, viewId, 'edit')
    if (getQuery(event).record === 'delete') await deleteViewsCardRecord(tx, ctx, view, recordId)
    else await removeViewsCard(tx, view, recordId)
    return { ok: true }
  })
})
