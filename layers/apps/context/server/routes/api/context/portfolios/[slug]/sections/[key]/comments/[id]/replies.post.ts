// POST /api/context/portfolios/:slug/sections/:key/comments/:id/replies
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { logCreate } from '#core/server/utils/activity-logger'
import { getPortfolioBySlugOr404 } from '../../../../../../../../../utils/portfolio-helpers'
import { loadSection, requireKnownSection } from '../../../../../../../../../utils/section-helpers'

const Body = z.object({
  content: z.string().trim().min(1).max(8000)
})

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.write', async (tx, ctx) => {
    const slug = getRouterParam(event, 'slug') ?? ''
    const key = getRouterParam(event, 'key') ?? ''
    const commentId = getRouterParam(event, 'id') ?? ''
    const p = await getPortfolioBySlugOr404(tx, slug)
    await requireKnownSection(tx, p.id, key)
    const section = await loadSection(tx, p.id, key)
    if (!section) throw createError({ statusCode: 404, statusMessage: 'Section not found.' })

    const comment = await tx
      .selectFrom('context_section_comments')
      .select('id')
      .where('id', '=', commentId)
      .where('section_id', '=', section.id)
      .executeTakeFirst()
    if (!comment) throw createError({ statusCode: 404, statusMessage: 'Comment not found.' })

    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }

    const inserted = await tx
      .insertInto('context_section_comment_replies')
      .values({
        comment_id: comment.id,
        author_id: ctx.userId,
        content: parsed.data.content
      })
      .returning(['id', 'comment_id', 'author_id', 'content', 'created_at'])
      .executeTakeFirstOrThrow()

    logCreate('context_section_comment_replies', inserted.id, ctx.userId, {
      portfolio_id: p.id, comment_id: comment.id
    })

    return inserted
  })
})
