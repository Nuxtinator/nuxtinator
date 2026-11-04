// POST /api/helpinator/libraries/:id/sources/:sid/sync — re-crawl one URL
// entry. Never blocked by a run in progress: the new run supersedes it.
import { withOrgPermission } from '#tenant/server'
import { helpinatorGetLibraryOr404, helpinatorGetSourceOr404 } from '../../../../../../../utils/helpinator-libraries'
import { helpinatorStartSourceSync } from '../../../../../../../utils/helpinator-crawl'
import { helpinatorAdminSource } from '../../../../../../../utils/helpinator-admin'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'helpinator' }, 'helpinator.manage', async (tx, ctx) => {
    const library = await helpinatorGetLibraryOr404(tx, getRouterParam(event, 'id') ?? '')
    const source = await helpinatorGetSourceOr404(tx, library.id, getRouterParam(event, 'sid') ?? '')
    const run = await helpinatorStartSourceSync(tx, ctx.orgId ?? null, source)
    setResponseStatus(event, 202)
    return helpinatorAdminSource({ ...source, status: 'syncing', run_token: run.token })
  })
})
