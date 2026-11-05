import { withOrgPermission } from '#tenant/server'
import { listOrgAppGroups } from '../../../../../../utils/org-groups'

// The org's groups, with whether each can open the app.
export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, 'org.apps.manage', (tx, ctx) => listOrgAppGroups(event, tx, ctx.orgId))
})
