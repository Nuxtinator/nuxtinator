// DELETE /api/helpinator/libraries/:id/pages/:pid — prune one page (and its
// chunks). The next crawl of its source re-adds it unless the source is
// narrowed, so this is for one-off junk.
import { withOrgPermission } from '#tenant/server'
import { helpinatorGetLibraryOr404, helpinatorGetPageOr404 } from '../../../../../../utils/helpinator-libraries'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'helpinator' }, 'helpinator.manage', async (tx) => {
    const library = await helpinatorGetLibraryOr404(tx, getRouterParam(event, 'id') ?? '')
    const page = await helpinatorGetPageOr404(tx, library.id, getRouterParam(event, 'pid') ?? '')
    await tx.deleteFrom('helpinator_library_pages').where('id', '=', page.id).execute()
    return { ok: true }
  })
})
