import { getRouterParam } from 'h3'
import { adminDb as db } from '#tenant/admin-db'
import { requireHostAdmin } from '#tenant/server'
import { getApp } from '#core/server/utils/app-settings'

// Host admin turns an app on for one org. Marked source='host' so both admin
// UIs can show who set it. Org admins can still change it unless the app is
// host-controlled.
export default defineEventHandler(async (event) => {
  await requireHostAdmin(event)
  const orgId = getRouterParam(event, 'orgId')
  const appId = getRouterParam(event, 'appId')
  if (!orgId || !appId) throw createError({ statusCode: 400, statusMessage: 'orgId and appId required' })

  const app = await db.selectFrom('apps').select('id').where('id', '=', appId).executeTakeFirst()
  if (!app) throw createError({ statusCode: 404, statusMessage: 'App not found' })
  // Personal apps are turned on per user, never per org.
  if ((await getApp(db, appId))?.scope === 'user') {
    throw createError({ statusCode: 409, statusMessage: 'Personal apps are turned on per user' })
  }

  const now = new Date().toISOString()
  await db
    .insertInto('org_apps')
    .values({ org_id: orgId, app_id: appId, enabled: true, source: 'host', updated_at: now })
    .onConflict(oc => oc.columns(['org_id', 'app_id']).doUpdateSet({
      enabled: true, source: 'host', updated_at: now
    }))
    .execute()

  const nitro = useNitroApp()
  try {
    await nitro.hooks.callHook('app.enabled', { orgId, appId })
  } catch (err) { console.warn('[hook app.enabled]', err) }

  return { success: true }
})
