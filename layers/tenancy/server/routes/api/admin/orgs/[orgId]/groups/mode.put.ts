import { requireHostAdmin } from '#tenant/server'
import { asHostAdminInOrg, setOrgGroupMode } from '../../../../../../utils/org-groups'

// Host admin: switches the org's groups between audiences and teams.
export default defineEventHandler(async (event) => {
  const { userId } = await requireHostAdmin(event)
  return await asHostAdminInOrg(event, (tx, orgId) => setOrgGroupMode(event, tx, orgId, userId))
})
