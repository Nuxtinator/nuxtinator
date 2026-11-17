import { withOrgPermission } from '#tenant/server'
import { listMailSuppressions } from '#core/server/utils/mail-admin-api'

export default defineEventHandler(async (event) => {
  const orgId = await withOrgPermission(event, 'org.mail.manage', async (_tx, ctx) => ctx.orgId)
  return await listMailSuppressions(event, { orgId })
})
