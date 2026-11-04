import { getQuery } from 'h3'
import { withOrgContext } from '#tenant/server'
import { getNavItems } from '#core/server/utils/nav-registry'
import { isAppOpenToUser } from '#core/server/utils/groups'

export default defineEventHandler(async (event) => {
  return await withOrgContext(event, async (tx, ctx) => {
    const query = getQuery(event)
    const appId = typeof query.app === 'string' ? query.app : ''
    if (!appId) {
      throw createError({ statusCode: 400, statusMessage: 'app query parameter is required' })
    }
    if (!(await isAppOpenToUser(tx, { appId, orgId: ctx.orgId, userId: ctx.userId }))) return { items: [] }

    const items = getNavItems(appId)
      .filter((item) => {
        if (!item.requiredPermission) return true
        return ctx.perms.has(item.requiredPermission as never)
      })
      .map(item => ({
        ...item,
        // Substitute the active org slug into any `:orgSlug` placeholder so
        // sidebars emit direct links into the right org. Same convention as
        // `_apps.get.ts`.
        path: item.path.replace(':orgSlug', ctx.orgSlug)
      }))
    return { items }
  })
})
