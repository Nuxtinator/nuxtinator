// PUT /api/helpinator/libraries/:id/sources/:sid — change the path restriction,
// page cap or page size cap of a URL entry. Takes effect on the next crawl.
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { HELPINATOR_MAX_PAGE_MB, helpinatorGetLibraryOr404, helpinatorGetSourceOr404, helpinatorUpdateSource } from '../../../../../../utils/helpinator-libraries'
import { helpinatorAdminSource } from '../../../../../../utils/helpinator-admin'

const Body = z.object({
  restrict_to_path: z.boolean(),
  max_pages: z.number().int().min(1).max(1000),
  max_page_mb: z.number().int().min(1).max(HELPINATOR_MAX_PAGE_MB).optional()
})

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'helpinator' }, 'helpinator.manage', async (tx) => {
    const library = await helpinatorGetLibraryOr404(tx, getRouterParam(event, 'id') ?? '')
    const source = await helpinatorGetSourceOr404(tx, library.id, getRouterParam(event, 'sid') ?? '')
    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Invalid URL entry', data: parsed.error.flatten() })
    return helpinatorAdminSource(await helpinatorUpdateSource(tx, source, parsed.data))
  })
})
