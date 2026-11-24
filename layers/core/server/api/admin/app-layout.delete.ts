import { db } from '#core/server/utils/database'
import { requireOperatorAdmin } from '#tenant/server'
import { logEvent } from '../../utils/activity-logger'
import { saveAppLayout } from '../../utils/app-layout'

// Single mode: puts the apps back in their default categories and order.
export default defineEventHandler(async (event) => {
  const { userId } = await requireOperatorAdmin(event)
  if (useRuntimeConfig().public.tenancy) {
    throw createError({ statusCode: 400, statusMessage: 'Each organization arranges its own apps' })
  }
  const layout = await db.transaction().execute(tx => saveAppLayout(tx, null))
  logEvent({ eventType: 'app_layout_reset', tableName: 'core_settings', userId }).catch(() => {})
  return { layout }
})
