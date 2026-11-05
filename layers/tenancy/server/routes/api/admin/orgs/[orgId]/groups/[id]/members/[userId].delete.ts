import { requireHostAdmin } from '#tenant/server'
import { asHostAdminInOrg, removeOrgGroupMember } from '../../../../../../../../utils/org-groups'

// Host admin: removes someone from an org group.
export default defineEventHandler(async (event) => {
  const { userId } = await requireHostAdmin(event)
  return await asHostAdminInOrg(event, (tx, orgId) => removeOrgGroupMember(event, tx, orgId, userId))
})
