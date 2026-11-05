// GET /api/context/portfolios/:slug — read a single portfolio, with the teams
// it is limited to.
import { withOrgPermission } from '#tenant/server'
import { getContextTeamScope, getPortfolioBySlugOr404, withContextPortfolioTeams } from '../../../../utils/portfolio-helpers'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.read', async (tx, ctx) => {
    const slug = getRouterParam(event, 'slug') ?? ''
    const p = await getPortfolioBySlugOr404(tx, slug, await getContextTeamScope(event, tx, ctx))
    return (await withContextPortfolioTeams(tx, [p]))[0]
  })
})
