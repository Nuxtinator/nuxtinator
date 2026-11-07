// GET /api/views/:id/shares — who a view is shared with. Owner or 'edit'
// can see the list; only the owner changes it.
import { withOrgPermission } from '#tenant/server'
import { requireView } from '../../../../utils/views'

export default defineEventHandler(async (event) => {
  const viewId = getRouterParam(event, 'id')!
  return await withOrgPermission(event, { appId: 'views' }, 'views.use', async (tx, ctx) => {
    await requireView(tx, ctx, viewId, 'edit')
    const items = await tx
      .selectFrom('views_shares as s')
      .innerJoin('users as u', 'u.id', 's.user_id')
      .select(['s.user_id as userId', 's.level', 'u.display_name as displayName', 'u.email', 'u.avatar'])
      .where('s.view_id', '=', viewId)
      .orderBy('u.display_name')
      .execute()
    return { items }
  })
})
