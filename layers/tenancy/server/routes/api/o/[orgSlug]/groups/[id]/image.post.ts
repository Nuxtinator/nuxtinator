import { withOrgPermission } from '#tenant/server'
import { uploadOrgGroupImage } from '../../../../../../utils/org-groups'

// Uploads an org group's image (multipart field `file`).
export default defineEventHandler(async (event) => {
  return await uploadOrgGroupImage(event, fn => withOrgPermission(event, 'org.groups.manage', (tx, ctx) => fn(tx, ctx.orgId, ctx.userId)))
})
