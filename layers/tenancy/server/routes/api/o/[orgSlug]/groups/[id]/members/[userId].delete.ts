import { withOrgPermission } from '#tenant/server'
import { removeOrgGroupMember } from '../../../../../../../utils/org-groups'

// Removes someone from an org group.
export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, 'org.groups.manage', (tx, ctx) => removeOrgGroupMember(event, tx, ctx.orgId, ctx.userId))
})
