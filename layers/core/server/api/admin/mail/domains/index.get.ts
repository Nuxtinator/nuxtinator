import { requireOperatorAdmin } from '#tenant/server'
import { listMailDomains } from '#core/server/utils/mail-admin-api'

export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)
  return await listMailDomains({ orgId: null })
})
