// DELETE /api/views/favorites/:kind/:recordId — takes a card or board off the
// caller's favorites. Returns { ok: true }, also when it wasn't one.
import { withOrgPermission } from '#tenant/server'
import { parseFavoriteTarget, removeFavorite } from '../../../../../utils/favorites'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'views' }, 'views.use', async (tx, ctx) => {
    const { kind, recordId } = parseFavoriteTarget(getRouterParam(event, 'kind'), getRouterParam(event, 'recordId'))
    await removeFavorite(tx, ctx, kind, recordId)
    return { ok: true }
  })
})
