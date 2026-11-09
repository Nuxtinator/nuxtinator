import { getRouterParam } from 'h3'
import { adminDb as db } from '#tenant/admin-db'
import { requireHostAdmin } from '#tenant/server'
import { assertAppNotRequired } from '../../../../../../../utils/app-settings'

export default defineEventHandler(async (event) => {
  await requireHostAdmin(event)
  const orgId = getRouterParam(event, 'orgId')
  const appId = getRouterParam(event, 'appId')
  if (!orgId || !appId) throw createError({ statusCode: 400, statusMessage: 'orgId and appId required' })

  await assertAppNotRequired(db, orgId, appId)

  const now = new Date().toISOString()
  await db
    .insertInto('org_apps')
    .values({ org_id: orgId, app_id: appId, enabled: false, source: 'host', updated_at: now })
    .onConflict(oc => oc.columns(['org_id', 'app_id']).doUpdateSet({
      enabled: false, source: 'host', updated_at: now
    }))
    .execute()

  const nitro = useNitroApp()
  try {
    await nitro.hooks.callHook('app.disabled', { orgId, appId })
  } catch (err) { console.warn('[hook app.disabled]', err) }

  return { success: true }
})
