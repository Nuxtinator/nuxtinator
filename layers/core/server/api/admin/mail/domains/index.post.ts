import { requireOperatorAdmin } from '#tenant/server'
import { createMailDomain } from '#core/server/utils/mail-admin-api'

export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)
  return await createMailDomain(event, { orgId: null })
})
