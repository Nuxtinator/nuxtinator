// POST /api/messages/items/:id/star
// Stars the item for the caller. Idempotent.

import { withOrgPermission } from '#tenant/server'
import { requireConversationAccess } from '../../../../../utils/conversation-access'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'messages' }, 'messages.read', async (tx, ctx) => {
    const itemId = getRouterParam(event, 'id')!

    const item = await tx
      .selectFrom('messages_items')
      .select(['id', 'conversation_id', 'deleted_at'])
      .where('id', '=', itemId)
      .executeTakeFirst()
    if (!item || item.deleted_at) {
      throw createError({ statusCode: 404, statusMessage: 'Item not found.' })
    }
    await requireConversationAccess(tx, ctx.userId, item.conversation_id)

    await tx
      .insertInto('messages_item_stars')
      .values({ user_id: ctx.userId, item_id: itemId })
      .onConflict(oc => oc.doNothing())
      .execute()

    return { ok: true, starred: true }
  })
})
