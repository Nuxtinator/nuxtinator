// DELETE .../comments/:id — delete a comment. Author or operator-admin.
// Cascade clears all replies via the FK.
import { withOrgPermission } from '#tenant/server'
import { db } from '#core/server/utils/database'
import { logDelete } from '#core/server/utils/activity-logger'
import { getPortfolioBySlugOr404 } from '../../../../../../../../utils/portfolio-helpers'
import { loadSection, requireKnownSection } from '../../../../../../../../utils/section-helpers'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.read', async (tx, ctx) => {
    const slug = getRouterParam(event, 'slug') ?? ''
    const key = getRouterParam(event, 'key') ?? ''
    const id = getRouterParam(event, 'id') ?? ''
    const p = await getPortfolioBySlugOr404(tx, slug)
    await requireKnownSection(tx, p.id, key)
    const section = await loadSection(tx, p.id, key)
    if (!section) throw createError({ statusCode: 404, statusMessage: 'Section not found.' })

    const existing = await tx
      .selectFrom('context_section_comments')
      .select(['id', 'author_id'])
      .where('id', '=', id)
      .where('section_id', '=', section.id)
      .executeTakeFirst()
    if (!existing) throw createError({ statusCode: 404, statusMessage: 'Comment not found.' })

    // Author can delete their own. Operator-admin can delete any.
    if (existing.author_id !== ctx.userId) {
      const userRow = await db
        .selectFrom('users')
        .select('is_admin')
        .where('id', '=', ctx.userId)
        .executeTakeFirst()
      if (!userRow?.is_admin) {
        throw createError({ statusCode: 403, statusMessage: 'Only the author or an operator admin can delete this comment.' })
      }
    }

    await tx
      .deleteFrom('context_section_comments')
      .where('id', '=', existing.id)
      .execute()

    logDelete('context_section_comments', existing.id, ctx.userId, {
      portfolio_id: p.id, section_id: section.id
    })

    return { ok: true, id: existing.id }
  })
})
