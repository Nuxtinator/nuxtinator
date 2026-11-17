import { requireOperatorAdmin } from '#tenant/server'
import { deleteMailDomain } from '#core/server/utils/mail-admin-api'

export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)
  return await deleteMailDomain({ orgId: null }, getRouterParam(event, 'id')!)
})
