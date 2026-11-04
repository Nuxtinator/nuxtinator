import { withOrgContext } from '#tenant/server'
import { getOrgApps } from '../../../../utils/app-settings'

// Every installed app's path with its per-org `enabled` flag and the user's
// `permitted` flag. Feeds the client page guard (`tenant-app-guard.global.ts`),
// which needs disabled apps' paths too so it can tell "a disabled app's page"
// apart from "a page that isn't an app". The API gate stays in `withOrgContext`.
export default defineEventHandler(async (event) => {
  return await withOrgContext(event, async (tx, ctx) => {
    const apps = await getOrgApps(tx, { orgId: ctx.orgId })
    return {
      apps: apps
        .filter(a => !!a.path)
        .map(a => ({
          id: a.id,
          title: a.title,
          path: a.path!,
          enabled: a.enabled,
          permitted: !a.requiredPermission || ctx.perms.has(a.requiredPermission as never)
        }))
    }
  })
})
