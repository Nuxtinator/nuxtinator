import { requireHostAdmin } from '#tenant/server'
import { asHostAdminInOrg, uploadOrgGroupImage } from '../../../../../../../utils/org-groups'

// Host admin: uploads an org group's image (multipart field `file`).
export default defineEventHandler(async (event) => {
  const { userId } = await requireHostAdmin(event)
  return await uploadOrgGroupImage(event, fn => asHostAdminInOrg(event, (tx, orgId) => fn(tx, orgId, userId)))
})
