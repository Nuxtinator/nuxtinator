import { db as adminDb } from '#core/server/utils/database'
import { getRegisteredApps } from '../utils/app-registry'

// Seeds the global `apps` catalog with one row per registered app layer.
//
// Idempotency rule: `INSERT ... ON CONFLICT DO NOTHING`, never `DO UPDATE`.
// The seeder owns row existence only (so `org_apps` can reference the app);
// it never writes `status`. A NULL status means the host admin hasn't chosen
// one, and the effective status comes from the layer's declared
// `defaultStatus` (see app-settings.ts `getApps`).
//
// Apps removed from the registry (layer uninstalled): the plugin does NOT
// delete the row. It stays around so re-installing the layer restores
// history. A separate `/admin/apps` UI lets host admin manually purge.
//
// ## Why we defer to first request
//
// Nitro plugins from the host run BEFORE plugins from app layers under
// `layers/apps/<id>/`. If we called `getRegisteredApps()` at plugin time
// the registry would be empty (mail/calendar's `register-*.ts` hasn't run
// yet) and we'd silently seed nothing. Hooking `request` with `hookOnce`
// fires exactly once on the first incoming HTTP request — by which time
// every plugin has finished initialising and the registry is populated.
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hookOnce('request', async () => {
    const apps = getRegisteredApps()
    if (apps.length === 0) return

    const databaseUrl = useRuntimeConfig().databaseUrl || process.env.DATABASE_URL
    if (!databaseUrl) return

    for (const app of apps) {
      try {
        await adminDb
          .insertInto('apps')
          .values({ id: app.id })
          .onConflict(oc => oc.column('id').doNothing())
          .execute()
      } catch (err) {
        console.warn(`[seed-apps-catalog] failed to seed app "${app.id}":`, err)
      }
    }
    console.log(`[seed-apps-catalog] ensured ${apps.length} apps in catalog: ${apps.map(a => a.id).join(', ')}`)
  })
})
