// GET /api/messages/items/:id/comments
// Returns: { comments: [...] } — flat list, client flattens by parent_comment_id.

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

    const rows = await tx
      .selectFrom('messages_comments as c')
      .innerJoin('users as u', 'u.id', 'c.author_id')
      .select([
        'c.id',
        'c.parent_comment_id',
        'c.body_md',
        'c.anchor',
        'c.anchor_orphaned',
        'c.created_at',
        'c.edited_at',
        'c.resolved_at',
        'c.author_id',
        'u.display_name as author_name',
        'u.avatar as author_avatar'
      ])
      .where('c.item_id', '=', itemId)
      .where('c.deleted_at', 'is', null)
      .orderBy('c.created_at', 'asc')
      .execute()

    if (rows.length === 0) return { comments: [] }

    const ids = rows.map(r => r.id)
    const reactionRows = await tx
      .selectFrom('messages_reactions')
      .select(['target_id', 'emoji', 'user_id'])
      .where('target_kind', '=', 'comment')
      .where('target_id', 'in', ids)
      .execute()
    const reactionMap = new Map<string, Map<string, { count: number, mine: boolean }>>()
    for (const r of reactionRows) {
      let m = reactionMap.get(r.target_id)
      if (!m) {
        m = new Map()
        reactionMap.set(r.target_id, m)
      }
      const cur = m.get(r.emoji) ?? { count: 0, mine: false }
      cur.count++
      if (r.user_id === ctx.userId) cur.mine = true
      m.set(r.emoji, cur)
    }

    return {
      comments: rows.map(r => ({
        id: r.id,
        parent_comment_id: r.parent_comment_id,
        body_md: r.body_md,
        anchor: r.anchor,
        anchor_orphaned: r.anchor_orphaned,
        created_at: r.created_at,
        edited_at: r.edited_at,
        resolved_at: r.resolved_at,
        author: { id: r.author_id, display_name: r.author_name, avatar: r.author_avatar },
        reactions: Array.from(reactionMap.get(r.id) ?? []).map(([emoji, { count, mine }]) => ({
          emoji, count, mine
        }))
      }))
    }
  })
})
