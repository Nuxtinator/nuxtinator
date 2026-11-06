import { requireHostAdmin } from '#tenant/server'
import { asHostAdminInOrg, updateOrgGroup } from '../../../../../../utils/org-groups'

// Host admin: renames an org group, changes its icon, or archives / restores it.
export default defineEventHandler(async (event) => {
  const { userId } = await requireHostAdmin(event)
  return await asHostAdminInOrg(event, (tx, orgId) => updateOrgGroup(event, tx, orgId, userId))
})
