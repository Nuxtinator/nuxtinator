// POST /api/context/suggestions/:id/read — marks the caller's notifications
// about this suggestion set read.
import { withOrgPermission } from '#tenant/server'
import { markSuggestionSetNotificationsRead } from '../../../../../utils/suggestions'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.read', async (tx, ctx) => {
    await markSuggestionSetNotificationsRead(tx, getRouterParam(event, 'id') ?? '', ctx.userId)
    return { ok: true }
  })
})
