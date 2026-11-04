// GET /api/ai/org/reindex-status — the active org's slice of the re-embed run.
import { withOrgPermission } from '#tenant/server'
import type { Permission } from '#core/app/utils/permissions'
import { getAiReindexStatus } from '#ai/server'

const ORG_SETTINGS_WRITE = 'org.settings.write' as Permission

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, ORG_SETTINGS_WRITE, async (_tx, ctx) => getAiReindexStatus(ctx.orgId))
})
