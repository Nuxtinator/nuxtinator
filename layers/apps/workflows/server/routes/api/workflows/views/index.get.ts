// GET /api/workflows/views — every view the caller can open: their own,
// views shared with them (visibility 'shared' + a share row), and org-wide
// views. Returns WorkflowsViewSummary[] with the caller's access level per
// view; the client does the mine/shared/org grouping.
import { withOrgPermission } from '#tenant/server'
import { listWorkflowsViews } from '../../../../utils/views'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'workflows' }, 'workflows.use', async (tx, ctx) => {
    return { items: await listWorkflowsViews(tx, ctx) }
  })
})
