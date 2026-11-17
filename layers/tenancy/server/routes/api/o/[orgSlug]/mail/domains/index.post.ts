import { withOrgPermission } from '#tenant/server'
import { createMailDomain } from '#core/server/utils/mail-admin-api'

// An org's domain is provisioned on the host's org accounts unless the org
// picks one of its own.
export default defineEventHandler(async (event) => {
  const orgId = await withOrgPermission(event, 'org.mail.manage', async (_tx, ctx) => ctx.orgId)
  return await createMailDomain(event, { orgId }, { useHostOrgAccounts: true })
})
