import { requireOperatorAdmin } from '#tenant/server'
import { sendMailTest } from '#core/server/utils/mail-admin-api'

export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)
  return await sendMailTest(event, { orgId: null })
})
