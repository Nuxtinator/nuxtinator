import { withOrgPermission } from '#tenant/server'
import { setOrgAppGroups } from '../../../../../../utils/org-groups'

// Limits an org app to some of the org's groups (none: open to everyone).
export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, 'org.apps.manage', (tx, ctx) => setOrgAppGroups(event, tx, ctx.orgId, ctx.userId))
})
