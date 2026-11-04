// POST /api/ai/org/reindex — rebuild the active org's vector indexes with the
// embedding model that resolves for it now. Fire-and-forget; progress from
// GET /api/ai/org/reindex-status. Gated by org.settings.write.
import { withOrgPermission } from '#tenant/server'
import type { Permission } from '#core/app/utils/permissions'
import { startAiReindex, getAiReindexStatus } from '#ai/server'

const ORG_SETTINGS_WRITE = 'org.settings.write' as Permission

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, ORG_SETTINGS_WRITE, async (_tx, ctx) => {
    const { started } = startAiReindex([ctx.orgId])
    return { started, reason: started ? null : 'already-running', status: getAiReindexStatus(ctx.orgId) }
  })
})
