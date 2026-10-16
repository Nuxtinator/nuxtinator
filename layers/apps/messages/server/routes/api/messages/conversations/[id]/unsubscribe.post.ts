// POST /api/messages/conversations/:id/unsubscribe
// Opt the caller out of digest notifications for this channel.

import { withOrgPermission } from '#tenant/server'
import { requireConversationAccess } from '../../../../../utils/conversation-access'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'messages' }, 'messages.read', async (tx, ctx) => {
    const conversationId = getRouterParam(event, 'id')!
    const conv = await requireConversationAccess(tx, ctx.userId, conversationId)

    if (conv.kind === 'channel') {
      // Record an explicit opt-out (subscribed = false) rather than deleting
      // the row, so auto-subscribe-on-visit won't silently re-subscribe later.
      await tx
        .insertInto('messages_channel_subscriptions')
        .values({ channel_id: conv.id, user_id: ctx.userId, subscribed: false })
        .onConflict(oc => oc
          .columns(['channel_id', 'user_id'])
          .doUpdateSet({ subscribed: false })
        )
        .execute()
    }

    return { subscribed: false }
  })
})
