// PUT /api/context/portfolios/:slug/sections/:key — save section content.
// Atomic: upserts the section row and inserts a version row in a single tx.
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { logUpdate } from '#core/server/utils/activity-logger'
import { getPortfolioBySlugOr404 } from '../../../../../../utils/portfolio-helpers'
import { saveSectionContent } from '../../../../../../utils/section-helpers'

const Body = z.object({
  content: z.string()
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

    const { section, versionId } = await saveSectionContent(
      tx, p.id, key, parsed.data.content, ctx.userId, { source: 'user' }
    )

    logUpdate('context_sections', section.id, ctx.userId, {
      portfolio_id: p.id,
      key,
      version_id: versionId
    })

    return {
      id: section.id,
      portfolio_id: section.portfolio_id,
      key: section.section_key,
      content: section.content,
      last_edited_at: section.last_edited_at,
      last_edited_by: section.last_edited_by,
      version_id: versionId
    }
  })
})
