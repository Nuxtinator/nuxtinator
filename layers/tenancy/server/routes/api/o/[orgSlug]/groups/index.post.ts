import { withOrgPermission } from '#tenant/server'
import { createOrgGroup } from '../../../../../utils/org-groups'

// Creates a group in the org.
export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, 'org.groups.manage', (tx, ctx) => createOrgGroup(event, tx, ctx.orgId, ctx.userId))
})
