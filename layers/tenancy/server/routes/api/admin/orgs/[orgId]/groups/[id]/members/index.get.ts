import { requireHostAdmin } from '#tenant/server'
import { asHostAdminInOrg, listOrgGroupMembers } from '../../../../../../../../utils/org-groups'

// Host admin: an org group's members.
export default defineEventHandler(async (event) => {
  await requireHostAdmin(event)
  return await asHostAdminInOrg(event, (tx, orgId) => listOrgGroupMembers(event, tx, orgId))
})
