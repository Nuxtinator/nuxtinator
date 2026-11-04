// GET /api/ai/org/usage?period=month|last_month|30d|all
// The active org's AI spend for its settings page. Gated by
// org.settings.write, like the org's other AI settings routes.
import { getQuery } from 'h3'
import { withOrgPermission } from '#tenant/server'
import type { Permission } from '#core/app/utils/permissions'
import { getUsageSummary } from '../../../../utils/ai-usage'
import { AI_USAGE_PERIODS, type AiUsagePeriod } from '../../../../../app/utils/ai-manifest'

const ORG_SETTINGS_WRITE = 'org.settings.write' as Permission

export default defineEventHandler(async (event) => {
  const q = getQuery(event).period
  const period = AI_USAGE_PERIODS.includes(q as AiUsagePeriod) ? q as AiUsagePeriod : 'month'
  return await withOrgPermission(event, ORG_SETTINGS_WRITE, tx => getUsageSummary(tx, { kind: 'org' }, period))
})
