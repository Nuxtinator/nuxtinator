import { requireHostAdmin } from '#tenant/server'
import { asHostAdminInOrg, removeOrgGroupImage } from '../../../../../../../utils/org-groups'

// Host admin: removes an org group's image.
export default defineEventHandler(async (event) => {
  const { userId } = await requireHostAdmin(event)
  return await asHostAdminInOrg(event, (tx, orgId) => removeOrgGroupImage(event, tx, orgId, userId))
})
