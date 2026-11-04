// POST /api/helpinator/libraries/:id/sources — add a URL entry and start its
// first crawl. Answers 202 with the source in `syncing` state.
import { withOrgPermission } from '#tenant/server'
import { HelpinatorSourceInput, helpinatorGetLibraryOr404, helpinatorAddSource } from '../../../../../../utils/helpinator-libraries'
import { helpinatorStartSourceSync } from '../../../../../../utils/helpinator-crawl'
import { helpinatorAdminSource } from '../../../../../../utils/helpinator-admin'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'helpinator' }, 'helpinator.manage', async (tx, ctx) => {
    const library = await helpinatorGetLibraryOr404(tx, getRouterParam(event, 'id') ?? '')
    const parsed = HelpinatorSourceInput.safeParse(await readBody(event))
    if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Invalid URL entry', data: parsed.error.flatten() })
    const source = await helpinatorAddSource(tx, library, parsed.data)
    const run = await helpinatorStartSourceSync(tx, ctx.orgId ?? null, source)
    setResponseStatus(event, 202)
    return helpinatorAdminSource({ ...source, status: 'syncing', run_token: run.token })
  })
})
