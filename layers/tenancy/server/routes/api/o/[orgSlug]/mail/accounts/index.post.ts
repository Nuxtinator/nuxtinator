import { withOrgPermission } from '#tenant/server'
import { createMailAccount } from '#core/server/utils/mail-admin-api'

export default defineEventHandler(async (event) => {
  const { orgId, userId } = await withOrgPermission(event, 'org.mail.manage', async (_tx, ctx) => ({ orgId: ctx.orgId, userId: ctx.userId }))
  return await createMailAccount(event, { orgId }, userId)
})
