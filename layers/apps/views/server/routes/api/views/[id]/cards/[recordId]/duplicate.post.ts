// POST /api/views/:id/cards/:recordId/duplicate — copy a card's record (see
// duplicateViewsCard for what the copy takes and the permissions it needs).
// Returns the copy's id.
import { withOrgPermission } from '#tenant/server'
import { requireView } from '../../../../../../utils/views'
import { duplicateViewsCard } from '../../../../../../utils/placements'

export default defineEventHandler(async (event) => {
  const viewId = getRouterParam(event, 'id')!
  const recordId = getRouterParam(event, 'recordId')!
  return await withOrgPermission(event, { appId: 'views' }, 'views.use', async (tx, ctx) => {
    const { view, access } = await requireView(tx, ctx, viewId, 'view')
    return { ok: true, ...await duplicateViewsCard(tx, ctx, view, access, recordId) }
  })
})
