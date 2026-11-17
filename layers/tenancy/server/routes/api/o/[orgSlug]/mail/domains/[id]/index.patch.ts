import { withOrgPermission } from '#tenant/server'
import { patchMailDomain } from '#core/server/utils/mail-admin-api'

export default defineEventHandler(async (event) => {
  const orgId = await withOrgPermission(event, 'org.mail.manage', async (_tx, ctx) => ctx.orgId)
  return await patchMailDomain(event, { orgId }, getRouterParam(event, 'id')!)
})
