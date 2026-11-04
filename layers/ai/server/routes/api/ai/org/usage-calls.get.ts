// GET /api/ai/org/usage-calls?cursor=
// The active org's AI calls, newest first, a page at a time. Gated by
// org.settings.write, like the org's spend summary.
import { getQuery } from 'h3'
import { withOrgPermission } from '#tenant/server'
import type { Permission } from '#core/app/utils/permissions'
import { getUsageCalls } from '../../../../utils/ai-usage'

const ORG_SETTINGS_WRITE = 'org.settings.write' as Permission

export default defineEventHandler(async (event) => {
  const cursor = getQuery(event).cursor
  return await withOrgPermission(event, ORG_SETTINGS_WRITE, tx => getUsageCalls(tx, typeof cursor === 'string' && cursor ? cursor : null))
})
