// GET /api/context/suggestions/:id — one suggestion set with each section's
// proposed, base, and current content.
import { withOrgPermission } from '#tenant/server'
import { getSuggestionSetOr404, REVIEW_PERMISSION } from '../../../../utils/suggestions'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.read', async (tx, ctx) => {
    const id = getRouterParam(event, 'id') ?? ''
    const isReviewer = ctx.perms.has(REVIEW_PERMISSION)
    const set = await getSuggestionSetOr404(tx, id, { userId: ctx.userId, isReviewer })
    return { set, can_review: isReviewer, is_author: set.author_id === ctx.userId }
  })
})
