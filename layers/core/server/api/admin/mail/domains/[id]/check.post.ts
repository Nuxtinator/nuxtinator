import { requireOperatorAdmin } from '#tenant/server'
import { checkMailDomain } from '#core/server/utils/mail-admin-api'

export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)
  return await checkMailDomain({ orgId: null }, getRouterParam(event, 'id')!)
})
