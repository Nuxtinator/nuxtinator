import { getRouterParam } from 'h3'
import { adminDb } from '#tenant/admin-db'
import { requireHostAdmin } from '#tenant/server'
import { getApp } from '#core/server/utils/app-settings'
import { resolveOrgAppEnabled } from '../../../../../utils/app-settings'

// Host admin: every org with whether it has this app on. Toggling goes
// through /api/admin/orgs/:orgId/apps/:appId/{enable,disable}.
export default defineEventHandler(async (event) => {
  await requireHostAdmin(event)
  const appId = getRouterParam(event, 'appId')
  if (!appId) throw createError({ statusCode: 400, statusMessage: 'appId required' })

  const app = await getApp(adminDb, appId)
  if (!app?.installed) throw createError({ statusCode: 404, statusMessage: 'App not found' })

  const rows = await adminDb
    .selectFrom('orgs')
    .leftJoin('org_apps', join => join.onRef('org_apps.org_id', '=', 'orgs.id').on('org_apps.app_id', '=', appId))
    .select(['orgs.id as id', 'orgs.slug as slug', 'orgs.name as name', 'org_apps.enabled as enabled', 'org_apps.source as source'])
    .orderBy('orgs.name', 'asc')
    .execute()

  return {
    status: app.status,
    orgs: rows.map(r => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      enabled: resolveOrgAppEnabled(app.status, r.enabled === null ? undefined : { enabled: r.enabled }),
      source: r.source
    }))
  }
})
