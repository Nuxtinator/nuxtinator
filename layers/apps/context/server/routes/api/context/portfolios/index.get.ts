// GET /api/context/portfolios — list portfolios in the active org.
import { withOrgPermission } from '#tenant/server'
import { listPortfolios } from '../../../../utils/portfolio-helpers'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.read', async (tx) => {
    return { portfolios: await listPortfolios(tx) }
  })
})
