// GET /api/messages/search?q=...&limit=
// Postgres FTS over body_text on items + comments, scoped by RLS to this org
// and to the conversations the caller can access (channels + their own DMs).

import { sql } from 'kysely'
import { withOrgContext } from '#tenant/server'
import { accessibleConversationIds } from '../../../utils/conversation-access'

const MAX_LIMIT = 50

// HTML-escape the source body BEFORE handing it to ts_headline. ts_headline
// doesn't escape its input — it only wraps matches in <b>...</b> — so a body
// containing `<script>` would otherwise round-trip as live markup into the
// client's v-html. Escaping ampersand-first then angle/quote chars keeps the
// `<b>` markers it injects as the only HTML in the output.
const ESCAPED_BODY_ITEM = sql<string>`
  replace(
    replace(
      replace(
        replace(
          replace(coalesce(i.body_md, ''), '&', '&amp;'),
          '<', '&lt;'),
        '>', '&gt;'),
      '"', '&quot;'),
    '''', '&#39;')
`
const ESCAPED_BODY_COMMENT = sql<string>`
  replace(
    replace(
      replace(
        replace(
          replace(coalesce(c.body_md, ''), '&', '&amp;'),
          '<', '&lt;'),
        '>', '&gt;'),
      '"', '&quot;'),
    '''', '&#39;')
`

export default defineEventHandler(async (event) => {
  return await withOrgContext(event, { appId: 'messages' }, async (tx, ctx) => {
    const q = getQuery(event)
    const query = typeof q.q === 'string' ? q.q.trim() : ''
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(q.limit) || 20))
    if (!query) return { items: [], comments: [] }

    const tsQuery = sql<unknown>`websearch_to_tsquery('english', ${query})`

    const itemRows = await tx
      .selectFrom('messages_items as i')
      .innerJoin('users as u', 'u.id', 'i.author_id')
      .select([
        'i.id',
        'i.conversation_id',
        'i.kind',
        'i.body_md',
        'i.created_at',
        'i.author_id',
        'u.display_name as author_name',
        sql<string>`ts_headline('english', ${ESCAPED_BODY_ITEM}, ${tsQuery}, 'MaxWords=30,MinWords=10')`.as('headline')
      ])
      .where('i.deleted_at', 'is', null)
      .where('i.conversation_id', 'in', accessibleConversationIds(tx, ctx.userId))
      .where(sql<boolean>`i.body_tsv @@ ${tsQuery}`)
      .orderBy(sql`ts_rank(i.body_tsv, ${tsQuery})`, 'desc')
      .limit(limit)
      .execute()

    const commentRows = await tx
      .selectFrom('messages_comments as c')
      .innerJoin('messages_items as i', 'i.id', 'c.item_id')
      .innerJoin('users as u', 'u.id', 'c.author_id')
      .select([
        'c.id',
        'c.item_id',
        'i.conversation_id',
        'c.body_md',
        'c.created_at',
        'c.author_id',
        'u.display_name as author_name',
        sql<string>`ts_headline('english', ${ESCAPED_BODY_COMMENT}, ${tsQuery}, 'MaxWords=30,MinWords=10')`.as('headline')
      ])
      .where('c.deleted_at', 'is', null)
      .where('i.deleted_at', 'is', null)
      .where('i.conversation_id', 'in', accessibleConversationIds(tx, ctx.userId))
      .where(sql<boolean>`c.body_tsv @@ ${tsQuery}`)
      .orderBy(sql`ts_rank(c.body_tsv, ${tsQuery})`, 'desc')
      .limit(limit)
      .execute()

    return {
      items: itemRows.map(r => ({
        id: r.id,
        kind: r.kind,
        conversation_id: r.conversation_id,
        excerpt: r.headline,
        created_at: r.created_at,
        author: { id: r.author_id, display_name: r.author_name }
      })),
      comments: commentRows.map(r => ({
        id: r.id,
        item_id: r.item_id,
        conversation_id: r.conversation_id,
        excerpt: r.headline,
        created_at: r.created_at,
        author: { id: r.author_id, display_name: r.author_name }
      }))
    }
  })
})
