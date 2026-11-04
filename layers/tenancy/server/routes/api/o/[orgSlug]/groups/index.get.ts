import { withOrgPermission } from '#tenant/server'
import { listOrgGroups } from '../../../../../utils/org-groups'

// The org's groups, with member counts, and the mode they run in.
export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, 'org.groups.manage', (tx, ctx) => listOrgGroups(tx, ctx.orgId))
})
