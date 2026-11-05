// DELETE /api/context/portfolios/:slug — delete the portfolio (cascade clears
// sections, versions, custom defs, comments, replies).
import { withOrgPermission } from '#tenant/server'
import { logDelete } from '#core/server/utils/activity-logger'
import { getContextTeamScope, getPortfolioBySlugOr404 } from '../../../../utils/portfolio-helpers'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.portfolio.delete', async (tx, ctx) => {
    const slug = getRouterParam(event, 'slug') ?? ''
    const p = await getPortfolioBySlugOr404(tx, slug, await getContextTeamScope(event, tx, ctx))
    await tx
      .deleteFrom('context_portfolios')
      .where('id', '=', p.id)
      .execute()
    logDelete('context_portfolios', p.id, ctx.userId, { slug: p.slug, name: p.name })
    return { ok: true, id: p.id }
  })
})
