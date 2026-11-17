import { requireOperatorAdmin } from '#tenant/server'
import { listMailAccounts } from '#core/server/utils/mail-admin-api'

export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)
  return await listMailAccounts({ orgId: null })
})
