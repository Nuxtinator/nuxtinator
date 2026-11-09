import { withOrgContext } from '#tenant/server'
import { getOrgApps } from '../../../../../utils/app-settings'

// Per-org app status. Registry-first three-tier merge — see
// `server/utils/app-settings.ts`. UI for `/@<slug>/settings/apps`.
// A host-controlled app is listed only while it's on for the org. `groups`
// names the org groups an app is limited to (the team gate); empty means open.
// It's filled only for callers who manage the org's apps or groups.
// `requiredBy` names the enabled apps that keep an app on.
export default defineEventHandler((event) => {
  return withOrgContext(event, async (tx, ctx) => {
    const apps = await getOrgApps(tx, { orgId: ctx.orgId })
    const seesGroups = ctx.perms.has('org.apps.manage') || ctx.perms.has('org.groups.manage')
    const limits = seesGroups
      ? await tx
          .selectFrom('app_groups')
          .innerJoin('groups', 'groups.id', 'app_groups.group_id')
          .select(['app_groups.app_id', 'groups.name'])
          .where('groups.org_id', '=', ctx.orgId)
          .orderBy('groups.name')
          .execute()
      : []
    return {
      apps: apps.filter(a => a.status !== 'host_controlled' || a.enabled).map(a => ({
        appId: a.id,
        title: a.title,
        description: a.description,
        icon: a.icon,
        globalStatus: a.globalStatus,
        enabled: a.enabled,
        source: a.source,
        lockedByHost: a.lockedByHost,
        requiredBy: a.requiredBy.map(id => apps.find(x => x.id === id)?.title ?? id),
        groups: limits.filter(l => l.app_id === a.id).map(l => l.name)
      }))
    }
  })
})
