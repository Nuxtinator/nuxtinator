// DELETE /api/views/:id — owner only (the host admin role counts
// as owner). The records created on a hand-picked view that no other view
// holds are deleted with it; shares and card placements go via FK cascade.
import { withOrgPermission } from '#tenant/server'
import { ownCardsQuery, ownsItsCards, requireView } from '../../../utils/views'

export default defineEventHandler(async (event) => {
  const viewId = getRouterParam(event, 'id')!
  return await withOrgPermission(event, { appId: 'views' }, 'views.use', async (tx, ctx) => {
    const { view } = await requireView(tx, ctx, viewId, 'owner')
    const own = await ownsItsCards(tx, view) ? await ownCardsQuery(tx, viewId).select('i.record_id').execute() : []
    if (own.length > 0) {
      await tx.deleteFrom('records_entries').where('id', 'in', own.map(r => r.record_id)).execute()
    }
    await tx.deleteFrom('views_definitions').where('id', '=', viewId).execute()
    return { ok: true }
  })
})
