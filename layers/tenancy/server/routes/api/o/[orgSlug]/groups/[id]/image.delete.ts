import { withOrgPermission } from '#tenant/server'
import { removeOrgGroupImage } from '../../../../../../utils/org-groups'

// Removes an org group's image.
export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, 'org.groups.manage', (tx, ctx) => removeOrgGroupImage(event, tx, ctx.orgId, ctx.userId))
})
