import { withOrgPermission } from '#tenant/server'
import { deleteOrgGroup } from '../../../../../utils/org-groups'

// Deletes an org group, unless content is still limited to it (409).
export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, 'org.groups.manage', (tx, ctx) => deleteOrgGroup(event, tx, ctx.orgId, ctx.userId))
})
