// DELETE /api/messages/items/:id/tags
// Body: { tag: string }
// Removes the caller's tag from this item.

import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'

const Body = z.object({
  tag: z.string().trim().min(1).max(40)
})

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'messages' }, 'messages.read', async (tx, ctx) => {
    const itemId = getRouterParam(event, 'id')!

    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }
    const tag = parsed.data.tag.replace(/^#/, '').trim()

    await tx
      .deleteFrom('messages_item_tags')
      .where('user_id', '=', ctx.userId)
      .where('item_id', '=', itemId)
      .where('tag_name', '=', tag)
      .execute()

    return { ok: true }
  })
})
