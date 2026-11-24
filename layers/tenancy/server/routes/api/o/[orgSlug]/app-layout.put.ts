import { withOrgPermission } from '#tenant/server'
import { saveAppLayout } from '#core/server/utils/app-layout'
import { logEvent } from '#core/server/utils/activity-logger'

// Saves how the org groups and orders its apps (see app/utils/app-layout.ts).
export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  return await withOrgPermission(event, 'org.apps.manage', async (tx, ctx) => {
    const layout = await saveAppLayout(tx, body)
    logEvent({ eventType: 'app_layout_changed', tableName: 'core_settings', userId: ctx.userId, metadata: { orgId: ctx.orgId } }, tx).catch(() => {})
    return { layout }
  })
})
