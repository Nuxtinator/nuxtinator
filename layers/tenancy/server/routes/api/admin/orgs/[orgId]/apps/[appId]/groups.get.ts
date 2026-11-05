import { requireHostAdmin } from '#tenant/server'
import { asHostAdminInOrg, listOrgAppGroups } from '../../../../../../../utils/org-groups'

// Host admin: the org's groups, with whether each can open the app.
export default defineEventHandler(async (event) => {
  await requireHostAdmin(event)
  return await asHostAdminInOrg(event, (tx, orgId) => listOrgAppGroups(event, tx, orgId))
})
