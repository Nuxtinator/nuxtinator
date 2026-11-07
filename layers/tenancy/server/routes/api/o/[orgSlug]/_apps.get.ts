import { withOrgContext } from '#tenant/server'
import { getRegisteredApps } from '#core/server/utils/app-registry'
import { railItemsFor } from '#core/server/utils/rail-registry'
import { appsClosedToUser } from '#core/server/utils/groups'
import { getOrgEnabledApps } from '../../../../utils/app-settings'

// Per-org app launcher feed. Filtered by:
//   - the user's effective perms in this org (`requiredPermission` gate); AND
//   - the org's enabled-app set (`getOrgEnabledApps`); AND
//   - the team gate (apps limited to org groups the user is in none of).
//
// API-level enforcement of the second filter happens in `withOrgContext`'s
// `appId` opt — this endpoint is the discovery side (Layer 1), not the gate.
export default defineEventHandler(async (event) => {
  return await withOrgContext(event, async (tx, ctx) => {
    const enabled = await getOrgEnabledApps(tx, ctx.orgId)
    const closed = await appsClosedToUser(tx, ctx.orgId, ctx.userId)

    const apps = getRegisteredApps()
      .filter((app) => {
        if (app.launcher === false || !enabled.has(app.id) || closed.has(app.id)) return false
        if (!app.requiredPermission) return true
        return ctx.perms.has(app.requiredPermission as never)
      })
      .map(app => ({
        ...app,
        // Substitute the active org slug into any `:orgSlug` placeholder so the
        // launcher emits direct links into the right org without the layer
        // needing tenancy plumbing.
        path: app.path.replace(':orgSlug', ctx.orgSlug),
        rail: railItemsFor(app.id, ctx.perms, ctx.orgSlug)
      }))

    return { apps }
  })
})
