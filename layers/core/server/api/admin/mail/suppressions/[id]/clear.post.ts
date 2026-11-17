import { requireOperatorAdmin } from '#tenant/server'
import { clearMailSuppression } from '#core/server/utils/mail-admin-api'

export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)
  return await clearMailSuppression(event, { orgId: null }, getRouterParam(event, 'id')!)
})
