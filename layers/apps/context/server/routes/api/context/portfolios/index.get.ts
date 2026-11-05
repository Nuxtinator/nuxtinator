// GET /api/context/portfolios — list the portfolios the caller can see in the
// active org, with the teams each is limited to.
import { withOrgPermission } from '#tenant/server'
import { getContextTeamScope, listPortfolios, withContextPortfolioTeams } from '../../../../utils/portfolio-helpers'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.read', async (tx, ctx) => {
    const portfolios = await listPortfolios(tx, await getContextTeamScope(event, tx, ctx))
    return { portfolios: await withContextPortfolioTeams(tx, portfolios) }
  })
})
