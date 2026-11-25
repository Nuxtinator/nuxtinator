// GET /api/views/favorites — the caller's favorite cards and card boards
// they can still see, oldest first: { items: ViewsFavorite[] }.
import { withOrgPermission } from '#tenant/server'
import { listFavorites } from '../../../../utils/favorites'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'views' }, 'views.use', async (tx, ctx) => {
    return { items: await listFavorites(tx, ctx) }
  })
})
