// GET /api/context/portfolios/:slug/sections/:key/comments
// Query: include_resolved=true to show resolved comments (default: only open).
import { withOrgPermission } from '#tenant/server'
import { getPortfolioBySlugOr404 } from '../../../../../../../../utils/portfolio-helpers'
import { loadSection, requireKnownSection } from '../../../../../../../../utils/section-helpers'
import { isAnchorStale } from '../../../../../../../../utils/comments'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.read', async (tx) => {
    const slug = getRouterParam(event, 'slug') ?? ''
    const key = getRouterParam(event, 'key') ?? ''
    const includeResolved = String(getQuery(event).include_resolved ?? '').toLowerCase() === 'true'
    const p = await getPortfolioBySlugOr404(tx, slug)
    await requireKnownSection(tx, p.id, key)
    const section = await loadSection(tx, p.id, key)
    if (!section) return { comments: [] }

    let qb = tx
      .selectFrom('context_section_comments as c')
      .leftJoin('users as a', 'a.id', 'c.author_id')
      .leftJoin('users as r', 'r.id', 'c.resolved_by')
      .select([
        'c.id',
        'c.section_id',
        'c.author_id',
        'c.quoted_text',
        'c.anchor_start',
        'c.anchor_end',
        'c.anchor_hash',
        'c.content',
        'c.is_resolved',
        'c.resolved_by',
        'c.resolved_at',
        'c.created_at',
        'a.display_name as author_name',
        'r.display_name as resolved_by_name'
      ])
      .where('c.section_id', '=', section.id)
      .orderBy('c.created_at', 'asc')

    if (!includeResolved) qb = qb.where('c.is_resolved', '=', false)
    const rows = await qb.execute()

    const ids = rows.map(r => r.id as string)
    const replyRows = ids.length
      ? await tx
        .selectFrom('context_section_comment_replies as r')
        .leftJoin('users as u', 'u.id', 'r.author_id')
        .select(['r.id', 'r.comment_id', 'r.author_id', 'r.content', 'r.created_at', 'u.display_name as author_name'])
        .where('r.comment_id', 'in', ids)
        .orderBy('r.created_at', 'asc')
        .execute()
      : []

    const repliesByComment = new Map<string, typeof replyRows>()
    for (const reply of replyRows) {
      const k = reply.comment_id as string
      const list = repliesByComment.get(k) ?? []
      list.push(reply)
      repliesByComment.set(k, list)
    }

    const content = section.content
    const comments = rows.map(c => ({
      ...c,
      anchor_stale: isAnchorStale(
        content,
        c.anchor_start as number,
        c.anchor_end as number,
        c.quoted_text as string
      ),
      replies: repliesByComment.get(c.id as string) ?? []
    }))

    return { section_id: section.id, comments }
  })
})
