// GET /api/helpinator/libraries/:id/pages/:pid — one crawled page as stored
// (markdown), for the admin "view" link. Read-only: corrections belong in a
// portfolio-backed library.
import { withOrgPermission } from '#tenant/server'
import { helpinatorGetLibraryOr404, helpinatorGetPageOr404 } from '../../../../../../utils/helpinator-libraries'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'helpinator' }, 'helpinator.manage', async (tx) => {
    const library = await helpinatorGetLibraryOr404(tx, getRouterParam(event, 'id') ?? '')
    const page = await helpinatorGetPageOr404(tx, library.id, getRouterParam(event, 'pid') ?? '')
    return { id: page.id, source_id: page.source_id, url: page.url, title: page.title, content: page.content, bytes: page.bytes, fetched_at: page.fetched_at }
  })
})
