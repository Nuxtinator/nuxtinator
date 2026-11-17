import { withOrgPermission } from '#tenant/server'
import { updateMailAccount } from '#core/server/utils/mail-admin-api'

export default defineEventHandler(async (event) => {
  const orgId = await withOrgPermission(event, 'org.mail.manage', async (_tx, ctx) => ctx.orgId)
  return await updateMailAccount(event, { orgId }, getRouterParam(event, 'id')!)
})
