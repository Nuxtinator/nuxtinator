// GET /api/ai/admin/usage?period=month|last_month|30d|all
// The whole deployment's AI spend, every org's and every personal app's, for
// the operator's spend page. Reads totals through `ai_usage_host_daily_totals`, which
// sees past RLS.
import { getQuery } from 'h3'
import { requireOperatorAdmin } from '#tenant/server'
import { db } from '#core/server/utils/database'
import { getUsageSummary } from '../../../../utils/ai-usage'
import { AI_USAGE_PERIODS, type AiUsagePeriod } from '../../../../../app/utils/ai-manifest'

export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)
  const q = getQuery(event).period
  const period = AI_USAGE_PERIODS.includes(q as AiUsagePeriod) ? q as AiUsagePeriod : 'month'
  const orgs = useRuntimeConfig(event).public.tenancy === true
  return await getUsageSummary(db, { kind: 'host', orgs }, period)
})
