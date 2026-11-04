// POST /api/context/portfolios/:slug/sections — add a section definition.
// Body is either `{ key }` (a built-in from the portfolio's template) or
// `{ title, description?, order? }` (a custom section keyed by the
// slugified title).
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { logCreate } from '#core/server/utils/activity-logger'
import { getPortfolioBySlugOr404 } from '../../../../../../utils/portfolio-helpers'
import { addSection } from '../../../../../../utils/section-helpers'

const Body = z.union([
  z.object({ key: z.string().min(1).max(64) }).strict(),
  z.object({
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).optional(),
    order: z.number().int().min(0).optional()
  }).strict()
])

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.section.custom', async (tx, ctx) => {
    const slug = getRouterParam(event, 'slug') ?? ''
    const p = await getPortfolioBySlugOr404(tx, slug)

    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }

    const section = await addSection(tx, p, parsed.data, ctx.userId)

    logCreate('context_section_definitions', section.id, ctx.userId, {
      portfolio_id: p.id, key: section.key, title: section.title
    })

    return section
  })
})
