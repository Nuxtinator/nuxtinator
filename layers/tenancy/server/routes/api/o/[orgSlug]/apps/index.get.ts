import { withOrgContext } from '#tenant/server'
import { getOrgApps } from '../../../../../utils/app-settings'

// Per-org app status. Registry-first three-tier merge — see
// `server/utils/app-settings.ts`. UI for `/@<slug>/settings/apps`.
// A host-controlled app is listed only while it's on for the org.
export default defineEventHandler((event) => {
  return withOrgContext(event, async (tx, ctx) => {
    const apps = await getOrgApps(tx, { orgId: ctx.orgId })
    return {
      apps: apps.filter(a => a.status !== 'host_controlled' || a.enabled).map(a => ({
        appId: a.id,
        title: a.title,
        description: a.description,
        icon: a.icon,
        globalStatus: a.globalStatus,
        enabled: a.enabled,
        source: a.source,
        lockedByHost: a.lockedByHost
      }))
    }
  })
})
