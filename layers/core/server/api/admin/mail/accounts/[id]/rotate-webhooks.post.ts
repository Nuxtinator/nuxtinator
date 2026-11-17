import { requireOperatorAdmin } from '#tenant/server'
import { rotateMailWebhooks } from '#core/server/utils/mail-admin-api'

export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)
  return await rotateMailWebhooks({ orgId: null }, getRouterParam(event, 'id')!)
})
