import { withOrgPermission } from '#tenant/server'
import { saveAppLayout } from '#core/server/utils/app-layout'
import { logEvent } from '#core/server/utils/activity-logger'

// Puts the org's apps back in their default categories and order.
export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, 'org.apps.manage', async (tx, ctx) => {
    const layout = await saveAppLayout(tx, null)
    logEvent({ eventType: 'app_layout_reset', tableName: 'core_settings', userId: ctx.userId, metadata: { orgId: ctx.orgId } }, tx).catch(() => {})
    return { layout }
  })
})
