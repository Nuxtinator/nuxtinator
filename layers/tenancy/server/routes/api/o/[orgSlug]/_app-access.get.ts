import { withOrgContext } from '#tenant/server'
import { appsClosedToUser } from '#core/server/utils/groups'
import { getOrgApps } from '../../../../utils/app-settings'

// Every installed app's path with its per-org `enabled` flag and the user's
// `permitted` flag (their role allows it and the team gate lets them in). Feeds the client page guard (`tenant-app-guard.global.ts`),
// which needs disabled apps' paths too so it can tell "a disabled app's page"
// apart from "a page that isn't an app". The API gate stays in `withOrgContext`.
export default defineEventHandler(async (event) => {
  return await withOrgContext(event, async (tx, ctx) => {
    const apps = await getOrgApps(tx, { orgId: ctx.orgId })
    const closed = await appsClosedToUser(tx, ctx.orgId, ctx.userId)
    return {
      apps: apps
        .filter(a => !!a.path)
        .map(a => ({
          id: a.id,
          title: a.title,
          path: a.path!,
          enabled: a.enabled,
          permitted: (!a.requiredPermission || ctx.perms.has(a.requiredPermission as never)) && !closed.has(a.id)
        }))
    }
  })
})
