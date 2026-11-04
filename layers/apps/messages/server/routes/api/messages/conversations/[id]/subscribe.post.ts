// POST /api/messages/conversations/:id/subscribe
// Opt the caller in to digest notifications for this channel. No-op for DMs.

import { withOrgPermission } from '#tenant/server'
import { requireConversationAccess } from '../../../../../utils/conversation-access'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'messages' }, 'messages.read', async (tx, ctx) => {
    const conversationId = getRouterParam(event, 'id')!
    const conv = await requireConversationAccess(tx, ctx.userId, conversationId)

    if (conv.kind !== 'channel') {
      return { subscribed: true } // DMs are implicitly notified for participants
    }

    await tx
      .insertInto('messages_channel_subscriptions')
      .values({ channel_id: conv.id, user_id: ctx.userId, subscribed: true })
      .onConflict(oc => oc
        .columns(['channel_id', 'user_id'])
        .doUpdateSet({ subscribed: true })
      )
      .execute()

    return { subscribed: true }
  })
})
