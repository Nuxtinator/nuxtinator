// GET /api/ai/admin/reindex-status — progress of the current or last re-embed run.
import { requireOperatorAdmin } from '#tenant/server'
import { getAiReindexStatus } from '#ai/server'

export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)
  return getAiReindexStatus()
})
