import { getQuery } from 'h3'
import { db } from '#core/server/utils/database'
import { requireAuth } from '#core/server/utils/auth'
import { getNavItems } from '#core/server/utils/nav-registry'
import { getUserEnabledApps, permissionsOfApps } from '#core/server/utils/personal-apps'

// In-app nav for a personal app, in both modes and whichever org the caller
// is in. Empty when the app isn't turned on for them.
export default defineEventHandler(async (event) => {
  const { userId } = requireAuth(event)
  const query = getQuery(event)
  const appId = typeof query.app === 'string' ? query.app : ''
  if (!appId) {
    throw createError({ statusCode: 400, statusMessage: 'app query parameter is required' })
  }
  const enabled = await getUserEnabledApps(db, userId)
  if (!enabled.some(a => a.id === appId)) return { items: [] }

  const perms = permissionsOfApps(enabled)
  const items = getNavItems(appId).filter(
    item => !item.requiredPermission || perms.has(item.requiredPermission as never)
  )
  return { items }
})
