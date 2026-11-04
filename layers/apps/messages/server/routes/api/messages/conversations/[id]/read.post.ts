// POST /api/messages/conversations/:id/read
// Mark the caller's read pointer for this conversation as "now". Idempotent.

import { sql } from 'kysely'
import { withOrgPermission } from '#tenant/server'
import { requireConversationAccess } from '../../../../../utils/conversation-access'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'messages' }, 'messages.read', async (tx, ctx) => {
    const conversationId = getRouterParam(event, 'id')!
    const conv = await requireConversationAccess(tx, ctx.userId, conversationId)

    await tx
      .insertInto('messages_conversation_reads')
      .values({
        user_id: ctx.userId,
        conversation_id: conv.id,
        last_read_at: sql<Date>`now()`
      })
      .onConflict(oc => oc
        .columns(['user_id', 'conversation_id'])
        .doUpdateSet({ last_read_at: sql<Date>`now()` })
      )
      .execute()

    // Also clear unread global notifications for this conversation. The
    // snapshot store has no conversation_id column, so we match on the link
    // messages writes (`/messages/<conversationId>`), which this layer owns.
    await tx
      .updateTable('notifications')
      .set({ read_at: sql<Date>`now()` })
      .where('user_id', '=', ctx.userId)
      .where('app_id', '=', 'messages')
      .where('link', '=', `/messages/${conv.id}`)
      .where('read_at', 'is', null)
      .execute()

    // Auto-subscribe to a channel the first time the caller opens it, so they
    // start receiving the daily digest without a manual opt-in. `doNothing`
    // on conflict means a prior explicit unsubscribe (subscribed = false) is
    // left untouched.
    if (conv.kind === 'channel') {
      await tx
        .insertInto('messages_channel_subscriptions')
        .values({ channel_id: conv.id, user_id: ctx.userId, subscribed: true })
        .onConflict(oc => oc.columns(['channel_id', 'user_id']).doNothing())
        .execute()
    }

    return { ok: true }
  })
})
