// DELETE /api/messages/items/:id/star
// Unstars the item for the caller. Idempotent.

import { withOrgPermission } from '#tenant/server'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'messages' }, 'messages.read', async (tx, ctx) => {
    const itemId = getRouterParam(event, 'id')!
    await tx
      .deleteFrom('messages_item_stars')
      .where('user_id', '=', ctx.userId)
      .where('item_id', '=', itemId)
      .execute()
    return { ok: true, starred: false }
  })
})
