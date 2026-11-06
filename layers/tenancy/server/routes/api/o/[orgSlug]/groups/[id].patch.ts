import { withOrgPermission } from '#tenant/server'
import { updateOrgGroup } from '../../../../../utils/org-groups'

// Renames an org group, changes its icon, or archives / restores it.
export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, 'org.groups.manage', (tx, ctx) => updateOrgGroup(event, tx, ctx.orgId, ctx.userId))
})
