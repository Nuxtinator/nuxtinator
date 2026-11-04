import { withOrgPermission } from '#tenant/server'
import { listOrgGroupMembers } from '../../../../../../../utils/org-groups'

// An org group's members.
export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, 'org.groups.manage', (tx, ctx) => listOrgGroupMembers(event, tx, ctx.orgId))
})
