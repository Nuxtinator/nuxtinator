import { db } from '#core/server/utils/database'
import { requireOperatorAdmin } from '#tenant/server'
import { logEvent } from '../../utils/activity-logger'
import { saveAppLayout } from '../../utils/app-layout'

// Single mode: saves how the deployment groups and orders its apps. With
// tenancy loaded each org arranges its own (`/api/o/<slug>/app-layout`).
export default defineEventHandler(async (event) => {
  const { userId } = await requireOperatorAdmin(event)
  if (useRuntimeConfig().public.tenancy) {
    throw createError({ statusCode: 400, statusMessage: 'Each organization arranges its own apps' })
  }
  const body = await readBody(event)
  const layout = await db.transaction().execute(tx => saveAppLayout(tx, body))
  logEvent({ eventType: 'app_layout_changed', tableName: 'core_settings', userId }).catch(() => {})
  return { layout }
})
