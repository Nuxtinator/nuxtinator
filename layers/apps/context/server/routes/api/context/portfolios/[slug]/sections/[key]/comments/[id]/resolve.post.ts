// POST .../comments/:id/resolve — mark a comment as resolved.
import { sql } from 'kysely'
import { withOrgPermission } from '#tenant/server'
import { logUpdate } from '#core/server/utils/activity-logger'
import { getPortfolioBySlugOr404 } from '../../../../../../../../../utils/portfolio-helpers'
import { loadSection, requireKnownSection } from '../../../../../../../../../utils/section-helpers'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.comment.resolve', async (tx, ctx) => {
    const slug = getRouterParam(event, 'slug') ?? ''
    const key = getRouterParam(event, 'key') ?? ''
    const id = getRouterParam(event, 'id') ?? ''
    const p = await getPortfolioBySlugOr404(tx, slug)
    await requireKnownSection(tx, p.id, key)
    const section = await loadSection(tx, p.id, key)
    if (!section) throw createError({ statusCode: 404, statusMessage: 'Section not found.' })

    const updated = await tx
      .updateTable('context_section_comments')
      .set({
        is_resolved: true,
        resolved_by: ctx.userId,
        resolved_at: sql<Date>`now()`
      })
      .where('id', '=', id)
      .where('section_id', '=', section.id)
      .returning(['id', 'is_resolved', 'resolved_by', 'resolved_at'])
      .executeTakeFirst()
    if (!updated) throw createError({ statusCode: 404, statusMessage: 'Comment not found.' })

    logUpdate('context_section_comments', updated.id, ctx.userId, { action: 'resolve' })
    return updated
  })
})
