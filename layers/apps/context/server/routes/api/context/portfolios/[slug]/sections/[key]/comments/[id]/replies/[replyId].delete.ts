// DELETE .../comments/:id/replies/:replyId — author or operator-admin.
import { withOrgPermission } from '#tenant/server'
import { db } from '#core/server/utils/database'
import { logDelete } from '#core/server/utils/activity-logger'
import { getPortfolioBySlugOr404 } from '../../../../../../../../../../utils/portfolio-helpers'
import { loadSection, requireKnownSection } from '../../../../../../../../../../utils/section-helpers'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.read', async (tx, ctx) => {
    const slug = getRouterParam(event, 'slug') ?? ''
    const key = getRouterParam(event, 'key') ?? ''
    const commentId = getRouterParam(event, 'id') ?? ''
    const replyId = getRouterParam(event, 'replyId') ?? ''
    const p = await getPortfolioBySlugOr404(tx, slug)
    await requireKnownSection(tx, p.id, key)
    const section = await loadSection(tx, p.id, key)
    if (!section) throw createError({ statusCode: 404, statusMessage: 'Section not found.' })

    const reply = await tx
      .selectFrom('context_section_comment_replies as r')
      .innerJoin('context_section_comments as c', 'c.id', 'r.comment_id')
      .select(['r.id', 'r.author_id', 'r.comment_id'])
      .where('r.id', '=', replyId)
      .where('r.comment_id', '=', commentId)
      .where('c.section_id', '=', section.id)
      .executeTakeFirst()
    if (!reply) throw createError({ statusCode: 404, statusMessage: 'Reply not found.' })

    if (reply.author_id !== ctx.userId) {
      const userRow = await db
        .selectFrom('users')
        .select('is_admin')
        .where('id', '=', ctx.userId)
        .executeTakeFirst()
      if (!userRow?.is_admin) {
        throw createError({ statusCode: 403, statusMessage: 'Only the author or an operator admin can delete this reply.' })
      }
    }

    await tx
      .deleteFrom('context_section_comment_replies')
      .where('id', '=', reply.id)
      .execute()

    logDelete('context_section_comment_replies', reply.id, ctx.userId, {
      portfolio_id: p.id, comment_id: reply.comment_id
    })

    return { ok: true, id: reply.id }
  })
})
