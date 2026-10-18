import { getRouterParam } from 'h3'
import { withOrgPermission } from '#tenant/server'
import { getApp } from '#core/server/utils/app-settings'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, 'org.apps.manage', async (tx, ctx) => {
    const appId = getRouterParam(event, 'appId')
    if (!appId) throw createError({ statusCode: 400, statusMessage: 'appId required' })

    const app = await getApp(tx, appId)
    if (!app?.installed) throw createError({ statusCode: 404, statusMessage: 'App not found' })
    if (app.status === 'disabled') {
      throw createError({ statusCode: 409, statusMessage: 'App is disabled at the host level' })
    }
    if (app.status === 'host_controlled') {
      throw createError({ statusCode: 409, statusMessage: 'App is managed by the host' })
    }

    const now = new Date().toISOString()
    await tx
      .insertInto('org_apps')
      .values({ org_id: ctx.orgId, app_id: appId, enabled: true, source: 'org_admin', updated_at: now })
      .onConflict(oc => oc.columns(['org_id', 'app_id']).doUpdateSet({
        enabled: true,
        source: 'org_admin',
        updated_at: now
      }))
      .execute()

    const nitro = useNitroApp()
    try {
      await nitro.hooks.callHook('app.enabled', { orgId: ctx.orgId, appId })
    } catch (err) { console.warn('[hook app.enabled]', err) }

    return { success: true, enabled: true, source: 'org_admin' }
  })
})
