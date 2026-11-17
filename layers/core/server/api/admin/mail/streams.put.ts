import { requireOperatorAdmin } from '#tenant/server'
import { putMailStreams } from '#core/server/utils/mail-admin-api'

export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)
  return await putMailStreams(event, { orgId: null })
})
