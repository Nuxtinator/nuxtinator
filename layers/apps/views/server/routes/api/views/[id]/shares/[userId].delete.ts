// DELETE /api/views/:id/shares/:userId — remove a share. Only the owner
// manages shares; a shared user may also remove themself (leave the view)
// regardless of level.
import { withOrgPermission } from '#tenant/server'
import { requireView } from '../../../../../utils/views'

export default defineEventHandler(async (event) => {
  const viewId = getRouterParam(event, 'id')!
  const userId = getRouterParam(event, 'userId')!
  return await withOrgPermission(event, { appId: 'views' }, 'views.use', async (tx, ctx) => {
    await requireView(tx, ctx, viewId, userId === ctx.userId ? 'view' : 'owner')
    await tx
      .deleteFrom('views_shares')
      .where('view_id', '=', viewId)
      .where('user_id', '=', userId)
      .execute()
    return { ok: true }
  })
})
