import { withOrgContext } from '#tenant/server'
import { getApps } from '#core/server/utils/app-settings'

// Host-level app launcher feed for single-tenant deploys. (Multi-tenant mode
// uses the org-scoped `/api/o/:slug/_apps` from the tenancy layer; this endpoint
// is the no-org analog `useApps` calls when tenancy isn't loaded.) Lists every
// installed, non-disabled app the user has permission to open ('host_controlled'
// counts as disabled, since there are no orgs to turn it on for) — `withOrgContext`
// resolves to the single-mode kernel, so `ctx.perms` is the user's global set.
// Personal apps come from `/api/_personal-apps` in both modes.
export default defineEventHandler(async (event) => {
  return await withOrgContext(event, async (tx, ctx) => {
    const apps = (await getApps(tx))
      .filter(a => a.installed && a.scope !== 'user' && a.status !== 'disabled' && a.status !== 'host_controlled')
      .filter(a => !a.requiredPermission || ctx.perms.has(a.requiredPermission as never))
      .map(a => ({
        id: a.id,
        title: a.title,
        path: a.path,
        icon: a.icon,
        description: a.description,
        requiredPermission: a.requiredPermission,
        order: a.order
      }))

    return { apps }
  })
})
