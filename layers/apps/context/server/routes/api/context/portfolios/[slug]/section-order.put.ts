// PUT /api/context/portfolios/:slug/section-order — set the order of every
// section from a full list of keys. Sits beside `sections/` rather than under
// it so the path can never shadow a section whose key is "section-order".
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { logUpdate } from '#core/server/utils/activity-logger'
import { getPortfolioBySlugOr404 } from '../../../../../utils/portfolio-helpers'
import { reorderSections } from '../../../../../utils/section-helpers'

const Body = z.object({
  keys: z.array(z.string().min(1).max(64)).min(1)
}).strict()

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.section.custom', async (tx, ctx) => {
    const slug = getRouterParam(event, 'slug') ?? ''
    const p = await getPortfolioBySlugOr404(tx, slug)

    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }

    const sections = await reorderSections(tx, p, parsed.data.keys)

    logUpdate('context_portfolios', p.id, ctx.userId, {
      action: 'reorder_sections', keys: parsed.data.keys
    })

    return { sections }
  })
})
