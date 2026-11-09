// GET /api/views — every view the caller can open: their own, views
// shared with them, views open to one of their teams, and org-wide views,
// plus the built-in views (declared in code) they can open. Returns
// { items: ViewSummary[], builtIns: ViewSummary[] } with the caller's access
// level per view; the client does the mine/shared/org grouping.
import { withOrgPermission } from '#tenant/server'
import { listBuiltInViewSummaries, listViews } from '../../../utils/views'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'views' }, 'views.use', async (tx, ctx) => {
    return {
      items: await listViews(tx, ctx),
      builtIns: await listBuiltInViewSummaries(tx, ctx)
    }
  })
})
