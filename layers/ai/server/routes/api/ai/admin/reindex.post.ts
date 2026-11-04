// POST /api/ai/admin/reindex
// Rebuild every vector index whose stored model no longer matches the model
// that resolves for its scope — or every scope with `{ all: true }`. Starts a
// fire-and-forget run in this process and returns at once; progress comes from
// GET /api/ai/admin/reindex-status. Operator-admin only.
import { readBody } from 'h3'
import { requireOperatorAdmin } from '#tenant/server'
import { listStaleAiScopes, startAiReindex, getAiReindexStatus } from '#ai/server'

export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)
  const body = ((await readBody(event)) ?? {}) as { all?: unknown }
  const scopes = body.all === true ? undefined : (await listStaleAiScopes()).map(s => s.orgId)
  if (scopes && scopes.length === 0) return { started: false, reason: 'nothing-stale', status: getAiReindexStatus() }
  const { started } = startAiReindex(scopes)
  return { started, reason: started ? null : 'already-running', status: getAiReindexStatus() }
})
