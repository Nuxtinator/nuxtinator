// POST /api/messages/items/:id/tags
// Body: { tag: string }
// Tags an item for the caller. Adds the tag to the user's vocabulary if new.

import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { requireConversationAccess } from '../../../../../utils/conversation-access'

const Body = z.object({
  tag: z.string().trim().min(1).max(40)
})

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

    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }
    const tag = parsed.data.tag.replace(/^#/, '').trim()
    if (!tag) {
      throw createError({ statusCode: 400, statusMessage: 'Tag cannot be empty.' })
    }

    // Add to user vocabulary (idempotent).
    await tx
      .insertInto('messages_user_tags')
      .values({ user_id: ctx.userId, tag_name: tag })
      .onConflict(oc => oc.doNothing())
      .execute()

    // Apply to the item (idempotent).
    await tx
      .insertInto('messages_item_tags')
      .values({ user_id: ctx.userId, item_id: itemId, tag_name: tag })
      .onConflict(oc => oc.doNothing())
      .execute()

    return { ok: true, tag }
  })
})
