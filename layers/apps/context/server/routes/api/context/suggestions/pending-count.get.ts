// GET /api/context/suggestions/pending-count — open sets the caller can see,
// for the sidebar badge.
import { withOrgPermission } from '#tenant/server'
import { countOpenSets, REVIEW_PERMISSION } from '../../../../utils/suggestions'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.read', async (tx, ctx) => {
    const isReviewer = ctx.perms.has(REVIEW_PERMISSION)
    const count = await countOpenSets(tx, { userId: ctx.userId, isReviewer })
    return { count, is_reviewer: isReviewer }
  })
})
