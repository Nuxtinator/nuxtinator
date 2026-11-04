// POST /api/context/portfolios — create a portfolio in the active org.
// `template` picks a registered portfolio template (omitted = the default);
// `builtin_sections` picks which of its sections it starts with (omitted =
// all, [] = none).
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { logCreate } from '#core/server/utils/activity-logger'
import { createPortfolio } from '../../../../utils/portfolio-helpers'

const Body = z.object({
  name: z.string().trim().min(1).max(120),
  color: z.string().trim().max(20).nullable().optional(),
  slug: z.string().trim().regex(/^[a-z][a-z0-9-]{1,39}$/).optional(),
  template: z.string().min(1).max(64).optional(),
  builtin_sections: z.array(z.string().min(1).max(64)).max(50).optional()
})

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.portfolio.create', async (tx, ctx) => {
    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }

    const inserted = await createPortfolio(tx, parsed.data, ctx.userId)

    logCreate('context_portfolios', inserted.id, ctx.userId, { slug: inserted.slug, name: inserted.name })

    return inserted
  })
})
