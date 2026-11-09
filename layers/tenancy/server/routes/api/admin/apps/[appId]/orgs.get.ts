import { getRouterParam } from 'h3'
import { adminDb } from '#tenant/admin-db'
import { requireHostAdmin } from '#tenant/server'
import { getApps } from '#core/server/utils/app-settings'
import { applyRequires, requiredByTitles, resolveOrgAppEnabled } from '../../../../../utils/app-settings'

// Host admin: every org with whether it has this app on, counting apps an
// enabled app requires (`requiredBy` names the apps keeping it on). Toggling
// goes through /api/admin/orgs/:orgId/apps/:appId/{enable,disable}.
export default defineEventHandler(async (event) => {
  await requireHostAdmin(event)
  const appId = getRouterParam(event, 'appId')
  if (!appId) throw createError({ statusCode: 400, statusMessage: 'appId required' })

  const catalog = (await getApps(adminDb)).filter(a => a.installed && a.scope !== 'user')
  const app = catalog.find(a => a.id === appId)
  if (!app) throw createError({ statusCode: 404, statusMessage: 'App not found' })

  const [orgs, rows] = await Promise.all([
    adminDb.selectFrom('orgs').select(['id', 'slug', 'name']).orderBy('name', 'asc').execute(),
    adminDb.selectFrom('org_apps').select(['org_id', 'app_id', 'enabled', 'source']).execute()
  ])
  const rowsByOrg = new Map<string, Map<string, { enabled: boolean, source: typeof rows[number]['source'] }>>()
  for (const r of rows) {
    const byApp = rowsByOrg.get(r.org_id) ?? new Map()
    byApp.set(r.app_id, { enabled: r.enabled, source: r.source })
    rowsByOrg.set(r.org_id, byApp)
  }

  return {
    status: app.status,
    orgs: orgs.map((org) => {
      const orgRows = rowsByOrg.get(org.id)
      const apps = applyRequires(catalog.map(a => ({ ...a, enabled: resolveOrgAppEnabled(a.status, orgRows?.get(a.id)) })))
      const entry = apps.find(a => a.id === appId)!
      return {
        id: org.id,
        slug: org.slug,
        name: org.name,
        enabled: entry.enabled,
        source: orgRows?.get(appId)?.source ?? null,
        requiredBy: requiredByTitles(entry, apps)
      }
    })
  }
})
