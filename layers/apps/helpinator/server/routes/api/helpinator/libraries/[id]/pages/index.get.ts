// GET /api/helpinator/libraries/:id/pages?source=&offset= — the crawled pages
// of a website library (url, title, size, fetched), paged.
import { withOrgPermission } from '#tenant/server'
import { HELPINATOR_UUID_RE } from '../../../../../../utils/helpinator-widgets'
import { helpinatorGetLibraryOr404, helpinatorListPages } from '../../../../../../utils/helpinator-libraries'

const PAGE = 100

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'helpinator' }, 'helpinator.manage', async (tx) => {
    const library = await helpinatorGetLibraryOr404(tx, getRouterParam(event, 'id') ?? '')
    const q = getQuery(event)
    const offset = Math.max(0, Number.parseInt(String(q.offset ?? '0'), 10) || 0)
    const sourceId = typeof q.source === 'string' && HELPINATOR_UUID_RE.test(q.source) ? q.source : undefined
    return await helpinatorListPages(tx, library.id, { limit: PAGE, offset, sourceId })
  })
})
