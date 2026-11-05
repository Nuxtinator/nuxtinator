import { withOrgPermission } from '#tenant/server'
import { addOrgGroupMember } from '../../../../../../../utils/org-groups'

// Adds an org member to an org group.
export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, 'org.groups.manage', (tx, ctx) => addOrgGroupMember(event, tx, ctx.orgId, ctx.userId))
})
