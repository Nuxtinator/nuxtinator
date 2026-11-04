// POST /api/helpinator/libraries/:id/sync — re-crawl every source of a website
// library. Each source gets a fresh run and the crawls run one after another
// in the background; answers 202 at once.
import { withOrgPermission } from '#tenant/server'
import { helpinatorGetLibraryOr404, helpinatorListSources } from '../../../../../utils/helpinator-libraries'
import { helpinatorStartSourceSync } from '../../../../../utils/helpinator-crawl'
import { helpinatorAdminSource } from '../../../../../utils/helpinator-admin'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'helpinator' }, 'helpinator.manage', async (tx, ctx) => {
    const library = await helpinatorGetLibraryOr404(tx, getRouterParam(event, 'id') ?? '')
    if (library.kind !== 'website') throw createError({ statusCode: 400, statusMessage: 'Only website libraries sync.' })
    const sources = await helpinatorListSources(tx, library.id)
    const started = []
    let chain = Promise.resolve()
    for (const source of sources) {
      const run = await helpinatorStartSourceSync(tx, ctx.orgId ?? null, source, { after: chain })
      chain = run.done
      started.push(helpinatorAdminSource({ ...source, status: 'syncing', run_token: run.token }))
    }
    setResponseStatus(event, 202)
    return { started: started.length, sources: started }
  })
})
