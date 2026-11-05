import { requireHostAdmin } from '#tenant/server'
import { asHostAdminInOrg, createOrgGroup } from '../../../../../../utils/org-groups'

// Host admin: creates a group in the org.
export default defineEventHandler(async (event) => {
  const { userId } = await requireHostAdmin(event)
  return await asHostAdminInOrg(event, (tx, orgId) => createOrgGroup(event, tx, orgId, userId))
})
