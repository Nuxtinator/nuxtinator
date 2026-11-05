// POST /api/context/suggestions/:id/read — marks the caller's notifications
// about this suggestion set read.
import { withOrgPermission } from '#tenant/server'
import { assertSuggestionSetVisible, markSuggestionSetNotificationsRead } from '../../../../../utils/suggestions'
import { getContextTeamScope } from '../../../../../utils/portfolio-helpers'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.read', async (tx, ctx) => {
    const id = getRouterParam(event, 'id') ?? ''
    await assertSuggestionSetVisible(tx, id, await getContextTeamScope(event, tx, ctx))
    await markSuggestionSetNotificationsRead(tx, id, ctx.userId)
    return { ok: true }
  })
})
