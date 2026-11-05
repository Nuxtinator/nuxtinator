import { requireHostAdmin } from '#tenant/server'
import { asHostAdminInOrg, deleteOrgGroup } from '../../../../../../utils/org-groups'

// Host admin: deletes an org group, unless content is still limited to it (409).
export default defineEventHandler(async (event) => {
  const { userId } = await requireHostAdmin(event)
  return await asHostAdminInOrg(event, (tx, orgId) => deleteOrgGroup(event, tx, orgId, userId))
})
