import { requireOperatorAdmin } from '#tenant/server'
import { verifyMailAccount } from '#core/server/utils/mail-admin-api'

export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)
  return await verifyMailAccount({ orgId: null }, getRouterParam(event, 'id')!)
})
