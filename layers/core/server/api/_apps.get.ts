import { withOrgContext } from '#tenant/server'
import { getApps } from '#core/server/utils/app-settings'
import { railItemsFor } from '#core/server/utils/rail-registry'
import { appsClosedToUser } from '#core/server/utils/groups'

// Host-level app launcher feed for single-tenant deploys. (Multi-tenant mode
// uses the org-scoped `/api/o/:slug/_apps` from the tenancy layer; this endpoint
// is the no-org analog `useApps` calls when tenancy isn't loaded.) Lists every
// installed, non-disabled app the user has permission to open ('host_controlled'
// counts as disabled, since there are no orgs to turn it on for, and so does
// 'admins', which only personal apps take) — `withOrgContext`
// resolves to the single-mode kernel, so `ctx.perms` is the user's global set.
// Apps limited to host groups the user is in none of (the team gate) are left out.
// Personal apps come from `/api/_personal-apps` in both modes.
export default defineEventHandler(async (event) => {
  return await withOrgContext(event, async (tx, ctx) => {
    const closed = await appsClosedToUser(tx, null, ctx.userId)
    const apps = (await getApps(tx))
      .filter(a => a.installed && a.launcher && a.scope !== 'user' && a.status !== 'disabled' && a.status !== 'host_controlled' && a.status !== 'admins')
      .filter(a => !a.requiredPermission || ctx.perms.has(a.requiredPermission as never))
      .filter(a => !closed.has(a.id))
      .map(a => ({
        id: a.id,
        title: a.title,
        path: a.path,
        icon: a.icon,
        description: a.description,
        requiredPermission: a.requiredPermission,
        order: a.order,
        rail: railItemsFor(a.id, ctx.perms)
      }))

    return { apps }
  })
})
