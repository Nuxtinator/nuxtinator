import { requireOperatorAdmin } from '#tenant/server'
import { getMailStreams } from '#core/server/utils/mail-admin-api'

export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)
  return await getMailStreams({ orgId: null })
})
