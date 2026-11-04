import { getQuery } from 'h3'
import { withOrgPermission } from '#tenant/server'
import { searchOrgGroupCandidates } from '../../../../../utils/org-groups'

// GET ?q= — org members who could be added to a group.
export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, 'org.groups.manage', (tx, ctx) => searchOrgGroupCandidates(tx, ctx.orgId, getQuery(event).q))
})
