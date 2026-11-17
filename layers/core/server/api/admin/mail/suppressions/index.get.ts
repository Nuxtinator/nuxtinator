import { requireOperatorAdmin } from '#tenant/server'
import { listMailSuppressions } from '#core/server/utils/mail-admin-api'

export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)
  return await listMailSuppressions(event, { orgId: null })
})
