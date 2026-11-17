import { requireOperatorAdmin } from '#tenant/server'
import { deleteMailAccount } from '#core/server/utils/mail-admin-api'

export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)
  return await deleteMailAccount({ orgId: null }, getRouterParam(event, 'id')!)
})
