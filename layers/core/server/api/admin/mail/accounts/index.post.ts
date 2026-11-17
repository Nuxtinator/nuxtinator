import { requireOperatorAdmin } from '#tenant/server'
import { createMailAccount } from '#core/server/utils/mail-admin-api'

export default defineEventHandler(async (event) => {
  const { userId } = await requireOperatorAdmin(event)
  return await createMailAccount(event, { orgId: null }, userId)
})
