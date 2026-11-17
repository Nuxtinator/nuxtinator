import { requireOperatorAdmin } from '#tenant/server'
import { updateMailAccount } from '#core/server/utils/mail-admin-api'

export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)
  return await updateMailAccount(event, { orgId: null }, getRouterParam(event, 'id')!)
})
