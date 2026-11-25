// PUT /api/views/favorites/:kind/:recordId — makes a record's card (kind
// 'card', body { viewId }: the view it opens on) or its board (kind 'board')
// one of the caller's favorites. Returns the ViewsFavorite.
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { viewsIsViewId } from '../../../../../../app/utils/views-types'
import { addFavorite, parseFavoriteTarget } from '../../../../../utils/favorites'

const Body = z.object({
  viewId: z.string().refine(viewsIsViewId, 'Invalid view id').optional()
}).strict()

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'views' }, 'views.use', async (tx, ctx) => {
    const { kind, recordId } = parseFavoriteTarget(getRouterParam(event, 'kind'), getRouterParam(event, 'recordId'))
    const parsed = Body.safeParse((await readBody(event)) ?? {})
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }
    return await addFavorite(tx, ctx, kind, recordId, parsed.data.viewId ?? null)
  })
})
