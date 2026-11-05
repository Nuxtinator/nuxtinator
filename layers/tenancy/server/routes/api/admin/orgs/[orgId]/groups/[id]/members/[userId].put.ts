import { requireHostAdmin } from '#tenant/server'
import { asHostAdminInOrg, addOrgGroupMember } from '../../../../../../../../utils/org-groups'

// Host admin: adds an org member to an org group.
export default defineEventHandler(async (event) => {
  const { userId } = await requireHostAdmin(event)
  return await asHostAdminInOrg(event, (tx, orgId) => addOrgGroupMember(event, tx, orgId, userId))
})
