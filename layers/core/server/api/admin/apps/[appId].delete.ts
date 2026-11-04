import { getRouterParam } from 'h3'
import { db } from '#core/server/utils/database'
import { requireOperatorAdmin } from '#tenant/server'
import { logEvent } from '../../../utils/activity-logger'
import { getApp } from '../../../utils/app-settings'

// Host admin: purge the catalog row of an app whose layer is no longer
// installed. Per-org rows (`org_apps`) cascade with it.
export default defineEventHandler(async (event) => {
  const { userId } = await requireOperatorAdmin(event)
  const appId = getRouterParam(event, 'appId')
  if (!appId) throw createError({ statusCode: 400, statusMessage: 'appId required' })

  const app = await getApp(db, appId)
  if (!app) throw createError({ statusCode: 404, statusMessage: 'App not found' })
  if (app.installed) {
    throw createError({ statusCode: 409, statusMessage: 'App layer is installed; remove it from extends: first' })
  }

  await db.deleteFrom('apps').where('id', '=', appId).execute()

  logEvent({
    eventType: 'admin_app_removed',
    userId,
    metadata: { appId }
  }).catch(() => {})

  return { success: true }
})
