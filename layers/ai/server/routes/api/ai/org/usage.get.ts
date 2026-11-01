// GET /api/ai/org/usage
// The active org's AI spend for its settings page. Gated by
// org.settings.write, like the org's other AI settings routes.
import { withOrgPermission } from '#tenant/server'
import type { Permission } from '#core/app/utils/permissions'
import { getUsageSummary } from '../../../../utils/ai-usage'

const ORG_SETTINGS_WRITE = 'org.settings.write' as Permission

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, ORG_SETTINGS_WRITE, tx => getUsageSummary(tx))
})
