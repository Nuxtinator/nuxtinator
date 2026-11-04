// GET /api/messages/conversations/:id/items?cursor=&limit=
// Paginated descending list of items, including reaction summaries and the
// caller's own tags / star state per item.

import { withOrgPermission } from '#tenant/server'
import { generateSignedUrl } from '#core/server/utils/storage'
import { requireConversationAccess } from '../../../../../utils/conversation-access'

const DEFAULT_LIMIT = 30
const MAX_LIMIT = 100

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'messages' }, 'messages.read', async (tx, ctx) => {
    const conversationId = getRouterParam(event, 'id')!
    const conv = await requireConversationAccess(tx, ctx.userId, conversationId)

    const q = getQuery(event)
    const cursor = typeof q.cursor === 'string' ? q.cursor : null  // ISO timestamp
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(q.limit) || DEFAULT_LIMIT))

    let qb = tx
      .selectFrom('messages_items as i')
      .innerJoin('users as u', 'u.id', 'i.author_id')
      .leftJoin('messages_item_stars as star', join =>
        join.onRef('star.item_id', '=', 'i.id').on('star.user_id', '=', ctx.userId))
      .select([
        'i.id',
        'i.kind',
        'i.body_md',
        'i.storage_key',
        'i.filename',
        'i.mime',
        'i.size_bytes',
        'i.created_at',
        'i.edited_at',
        'i.author_id',
        'u.display_name as author_name',
        'u.avatar as author_avatar',
        eb => eb('star.user_id', 'is not', null).as('starred')
      ])
      .where('i.conversation_id', '=', conv.id)
      .where('i.deleted_at', 'is', null)
      .orderBy('i.created_at', 'desc')
      .limit(limit + 1)

    if (cursor) {
      qb = qb.where('i.created_at', '<', new Date(cursor))
    }

    const rows = await qb.execute()
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows

    if (page.length === 0) {
      return { items: [], next_cursor: null }
    }

    const itemIds = page.map(r => r.id)

    // Reactions summary
    const reactionRows = await tx
      .selectFrom('messages_reactions')
      .select(['target_id', 'emoji', 'user_id'])
      .where('target_kind', '=', 'item')
      .where('target_id', 'in', itemIds)
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

    // Comment counts
    const commentCountRows = await tx
      .selectFrom('messages_comments')
      .select(['item_id', eb => eb.fn.countAll<string>().as('c')])
      .where('item_id', 'in', itemIds)
      .where('deleted_at', 'is', null)
      .groupBy('item_id')
      .execute()
    const commentCounts = new Map(commentCountRows.map(r => [r.item_id, Number(r.c)]))

    // Caller's tags per item
    const tagRows = await tx
      .selectFrom('messages_item_tags')
      .select(['item_id', 'tag_name'])
      .where('user_id', '=', ctx.userId)
      .where('item_id', 'in', itemIds)
      .execute()
    const tagMap = new Map<string, string[]>()
    for (const t of tagRows) {
      const arr = tagMap.get(t.item_id) ?? []
      arr.push(t.tag_name)
      tagMap.set(t.item_id, arr)
    }

    // Sign URLs for image/file items.
    const signed = new Map<string, string>()
    for (const r of page) {
      if (r.storage_key) {
        try {
          signed.set(r.id, await generateSignedUrl(r.storage_key))
        } catch {
          // best-effort; client renders without URL if signing fails
        }
      }
    }

    return {
      items: page.map(r => ({
        id: r.id,
        kind: r.kind,
        body_md: r.body_md,
        storage_key: r.storage_key,
        url: signed.get(r.id) ?? null,
        filename: r.filename,
        mime: r.mime,
        size_bytes: r.size_bytes,
        created_at: r.created_at,
        edited_at: r.edited_at,
        author: { id: r.author_id, display_name: r.author_name, avatar: r.author_avatar },
        starred: !!r.starred,
        my_tags: tagMap.get(r.id) ?? [],
        comment_count: commentCounts.get(r.id) ?? 0,
        reactions: Array.from(reactionMap.get(r.id) ?? []).map(([emoji, { count, mine }]) => ({
          emoji, count, mine
        }))
      })),
      next_cursor: hasMore ? (page[page.length - 1]!.created_at as Date).toISOString() : null
    }
  })
})
