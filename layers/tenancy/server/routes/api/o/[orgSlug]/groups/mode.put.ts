import { withOrgPermission } from '#tenant/server'
import { setOrgGroupMode } from '../../../../../utils/org-groups'

// Switches the org's groups between audiences and teams.
export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, 'org.groups.manage', (tx, ctx) => setOrgGroupMode(event, tx, ctx.orgId, ctx.userId))
})
