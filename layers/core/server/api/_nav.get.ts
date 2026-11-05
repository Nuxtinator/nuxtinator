import { getQuery } from 'h3'
import { withOrgContext } from '#tenant/server'
import { getNavItems } from '#core/server/utils/nav-registry'
import { isAppOpenToUser } from '#core/server/utils/groups'

// Host-level in-app nav feed for single-tenant deploys. (Multi-tenant mode uses
// the org-scoped `/api/o/:slug/_nav` from the tenancy layer; this endpoint is
// the no-org analog `useAppNav` calls when tenancy isn't loaded.) Returns the
// requested app's nav items the user has permission to see.
export default defineEventHandler(async (event) => {
  return await withOrgContext(event, async (tx, ctx) => {
    const query = getQuery(event)
    const appId = typeof query.app === 'string' ? query.app : ''
    if (!appId) {
      throw createError({ statusCode: 400, statusMessage: 'app query parameter is required' })
    }
    if (!(await isAppOpenToUser(tx, { appId, orgId: null, userId: ctx.userId }))) return { items: [] }

    const items = getNavItems(appId).filter(
      item => !item.requiredPermission || ctx.perms.has(item.requiredPermission as never)
    )

    return { items }
  })
})
