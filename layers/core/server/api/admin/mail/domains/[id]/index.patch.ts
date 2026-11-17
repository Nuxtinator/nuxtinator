import { requireOperatorAdmin } from '#tenant/server'
import { patchMailDomain } from '#core/server/utils/mail-admin-api'

export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)
  return await patchMailDomain(event, { orgId: null }, getRouterParam(event, 'id')!)
})
