import { getRouterParam } from 'h3'
import { db } from '#core/server/utils/database'
import { requireOperatorAdmin } from '#tenant/server'
import { logEvent } from '../../../utils/activity-logger'
import { getApp } from '../../../utils/app-settings'

// Host-admin global status toggle.
//
// Materialization rules (per Phase 5.4):
//   * available → default: for every org without an explicit row, INSERT
//     `org_apps(enabled=true, source='auto')`. Fire `app.enabled` per row.
//     This makes layer hooks see "this app turned on" for orgs that
//     previously inherited 'available'=off, matching the user-visible flip.
//   * default → available / host_controlled: for every org without an
//     explicit row, INSERT `org_apps(enabled=true, source='auto')` (no hook —
//     the app was already on). Existing orgs keep the app; new orgs after the
//     flip must opt in (available) or be turned on by a host admin
//     (host_controlled).
//   * available ↔ host_controlled: no row changes. Orgs with an enabled row
//     keep the app; the rest stay off.
//   * anything → disabled: no row changes. Status alone gates.
//   * disabled → default: same as available → default.
//   * disabled → available / host_controlled: no row changes.
//   * personal apps (`scope: 'user'`): no org rows, ever. 'default' turns the
//     app on for every user; 'available' / 'host_controlled' leave it on only
//     for users with a `user_apps` grant.
export default defineEventHandler(async (event) => {
  const { userId } = await requireOperatorAdmin(event)
  const appId = getRouterParam(event, 'appId')
  if (!appId) throw createError({ statusCode: 400, statusMessage: 'appId required' })
  const body = await readBody(event)
  const status = body?.status
  if (status !== 'disabled' && status !== 'available' && status !== 'default' && status !== 'host_controlled') {
    throw createError({ statusCode: 400, statusMessage: 'status must be disabled | available | default | host_controlled' })
  }

  const existing = await getApp(db, appId)
  if (!existing) throw createError({ statusCode: 404, statusMessage: 'App not found' })

  const oldStatus = existing.status
  if (oldStatus === status) return { id: appId, status }

  // Per-org materialization (orgs/org_apps) is multi-tenant only — those tables
  // exist when the tenancy layer is loaded. In single-tenant mode the app status
  // alone gates visibility, so the status update is all there is to do.
  // Personal apps have no org rows in either mode.
  const materializesOrgs = useRuntimeConfig(event).public.tenancy === true && existing.scope !== 'user'

  const now = new Date().toISOString()
  const flipsToDefault = status === 'default' && oldStatus !== 'default'
  const keepsExistingOrgs = oldStatus === 'default' && (status === 'available' || status === 'host_controlled')
  let materializedOrgIds: string[] = []

  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('apps')
      .values({ id: appId, status, updated_at: now })
      .onConflict(oc => oc.column('id').doUpdateSet({ status, updated_at: now }))
      .execute()

    if ((flipsToDefault || keepsExistingOrgs) && materializesOrgs) {
      // Find orgs with no row for this app; insert auto rows for each.
      const orgs = await (trx as any)
        .selectFrom('orgs')
        .leftJoin('org_apps', (join: any) => join.onRef('org_apps.org_id', '=', 'orgs.id').on('org_apps.app_id', '=', appId))
        .select('orgs.id as id')
        .where('org_apps.app_id', 'is', null)
        .execute() as Array<{ id: string }>
      materializedOrgIds = orgs.map(o => o.id)
      if (materializedOrgIds.length > 0) {
        await (trx as any)
          .insertInto('org_apps')
          .values(materializedOrgIds.map(id => ({
            org_id: id,
            app_id: appId,
            enabled: true,
            source: 'auto' as const,
            updated_at: now
          })))
          .execute()
      }
    }
  })

  const nitro = useNitroApp()
  for (const orgId of flipsToDefault ? materializedOrgIds : []) {
    try {
      await nitro.hooks.callHook('app.enabled', { orgId, appId })
    } catch (err) { console.warn('[hook app.enabled]', err) }
  }

  logEvent({
    eventType: 'admin_app_status_changed',
    userId,
    metadata: { appId, oldStatus, newStatus: status, materializedOrgs: materializedOrgIds.length }
  }).catch(() => {})

  return { id: appId, status, materialized: materializedOrgIds.length }
})
