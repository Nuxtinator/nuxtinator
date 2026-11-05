import { requireHostAdmin } from '#tenant/server'
import { asHostAdminInOrg, setOrgAppGroups } from '../../../../../../../utils/org-groups'

// Host admin: limits an org app to some of the org's groups (none: open to everyone).
export default defineEventHandler(async (event) => {
  const { userId } = await requireHostAdmin(event)
  return await asHostAdminInOrg(event, (tx, orgId) => setOrgAppGroups(event, tx, orgId, userId))
})
