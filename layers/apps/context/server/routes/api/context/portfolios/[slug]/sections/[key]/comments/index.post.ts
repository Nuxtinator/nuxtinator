// POST /api/context/portfolios/:slug/sections/:key/comments
// Body: { content, quoted_text, anchor_start, anchor_end }
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { logCreate } from '#core/server/utils/activity-logger'
import { getPortfolioBySlugOr404 } from '../../../../../../../../utils/portfolio-helpers'
import { loadSection, saveSectionContent, requireKnownSection } from '../../../../../../../../utils/section-helpers'
import { sha256 } from '../../../../../../../../utils/comments'

const Body = z.object({
  content: z.string().trim().min(1).max(8000),
  quoted_text: z.string().min(1).max(2000),
  anchor_start: z.number().int().min(0),
  anchor_end: z.number().int().min(0)
})

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.write', async (tx, ctx) => {
    const slug = getRouterParam(event, 'slug') ?? ''
    const key = getRouterParam(event, 'key') ?? ''
    const p = await getPortfolioBySlugOr404(tx, slug)

    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }
    const { content, quoted_text, anchor_start, anchor_end } = parsed.data
    if (anchor_end < anchor_start) {
      throw createError({ statusCode: 400, statusMessage: 'anchor_end must be >= anchor_start.' })
    }

    await requireKnownSection(tx, p.id, key)
    let section = await loadSection(tx, p.id, key)
    if (!section) {
      const { section: created } = await saveSectionContent(tx, p.id, key, '', ctx.userId, { source: 'user' })
      section = created
    }

    const inserted = await tx
      .insertInto('context_section_comments')
      .values({
        section_id: section.id,
        author_id: ctx.userId,
        quoted_text,
        anchor_start,
        anchor_end,
        anchor_hash: sha256(quoted_text),
        content
      })
      .returning(['id', 'section_id', 'author_id', 'quoted_text', 'anchor_start', 'anchor_end', 'anchor_hash', 'content', 'is_resolved', 'resolved_by', 'resolved_at', 'created_at'])
      .executeTakeFirstOrThrow()

    logCreate('context_section_comments', inserted.id, ctx.userId, {
      portfolio_id: p.id, section_id: section.id, key
    })

    return inserted
  })
})
