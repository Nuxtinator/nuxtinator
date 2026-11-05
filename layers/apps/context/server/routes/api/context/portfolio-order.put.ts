// PUT /api/context/portfolio-order — set the order of the portfolios the
// caller can see from a full list of their ids. Sits beside `portfolios/`
// rather than under it so the path can never shadow a portfolio slug.
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { logUpdate } from '#core/server/utils/activity-logger'
import { getContextTeamScope, reorderPortfolios } from '../../../utils/portfolio-helpers'

const Body = z.object({
  ids: z.array(z.string().uuid()).min(1)
}).strict()

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.settings', async (tx, ctx) => {
    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }

    const portfolios = await reorderPortfolios(tx, parsed.data.ids, await getContextTeamScope(event, tx, ctx))

    for (const [index, p] of portfolios.entries()) {
      logUpdate('context_portfolios', p.id, ctx.userId, { action: 'reorder_portfolios', order: index + 1 })
    }

    return { portfolios }
  })
})
