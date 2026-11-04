// GET /api/messages/mentions?cursor=&limit=
// Items + comments where the caller was mentioned, newest first.

import { withOrgPermission } from '#tenant/server'

const DEFAULT_LIMIT = 30
const MAX_LIMIT = 100

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'messages' }, 'messages.read', async (tx, ctx) => {
    const q = getQuery(event)
    const cursor = typeof q.cursor === 'string' ? q.cursor : null
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(q.limit) || DEFAULT_LIMIT))

    let qb = tx
      .selectFrom('messages_mentions as m')
      .leftJoin('messages_items as i', 'i.id', 'm.item_id')
      .leftJoin('messages_comments as c', 'c.id', 'm.comment_id')
      .leftJoin('users as actor', join =>
        join.on(eb => eb.or([
          eb('actor.id', '=', eb.ref('i.author_id')),
          eb('actor.id', '=', eb.ref('c.author_id'))
        ])))
      .select([
        'm.id',
        'm.item_id',
        'm.comment_id',
        'm.created_at',
        eb => eb.fn.coalesce('i.conversation_id', eb.ref('c.item_id')).as('ref_id'),
        'i.body_md as item_text',
        'c.body_md as comment_text',
        'actor.id as actor_id',
        'actor.display_name as actor_name',
        'actor.avatar as actor_avatar'
      ])
      .where('m.mentioned_user_id', '=', ctx.userId)
      .orderBy('m.created_at', 'desc')
      .limit(limit + 1)

    if (cursor) qb = qb.where('m.created_at', '<', new Date(cursor))

    const rows = await qb.execute()
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows

    return {
      mentions: page.map(r => ({
        id: r.id,
        created_at: r.created_at,
        item_id: r.item_id,
        comment_id: r.comment_id,
        excerpt: (r.comment_text ?? r.item_text ?? '').slice(0, 240),
        actor: r.actor_id
          ? { id: r.actor_id, display_name: r.actor_name, avatar: r.actor_avatar }
          : null
      })),
      next_cursor: hasMore ? (page[page.length - 1]!.created_at as Date).toISOString() : null
    }
  })
})
