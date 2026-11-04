// GET /api/context/suggestions?state=open|closed — the review queue. Open
// sets (anything still pending) come oldest first; closed sets newest first.
// Reviewers see every set in the org, everyone else only their own.
import { withOrgPermission } from '#tenant/server'
import { listSuggestionSets, REVIEW_PERMISSION } from '../../../../utils/suggestions'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.read', async (tx, ctx) => {
    const state = getQuery(event).state === 'closed' ? 'closed' : 'open'
    const sets = await listSuggestionSets(
      tx,
      { userId: ctx.userId, isReviewer: ctx.perms.has(REVIEW_PERMISSION) },
      { state }
    )
    return { sets }
  })
})
