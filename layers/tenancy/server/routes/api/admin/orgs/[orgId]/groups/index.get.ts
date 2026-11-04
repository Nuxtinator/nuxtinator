import { requireHostAdmin } from '#tenant/server'
import { asHostAdminInOrg, listOrgGroups } from '../../../../../../utils/org-groups'

// Host admin: the org's groups, with member counts, and the mode they run in.
export default defineEventHandler(async (event) => {
  await requireHostAdmin(event)
  return await asHostAdminInOrg(event, (tx, orgId) => listOrgGroups(tx, orgId))
})
