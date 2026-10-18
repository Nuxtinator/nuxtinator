import { db } from '#core/server/utils/database'
import { requireAuth } from '#core/server/utils/auth'
import { getPersonalAppPermissions, getUserEnabledApps } from '#core/server/utils/personal-apps'

// Launcher feed for personal apps (`registerApp({ scope: 'user' })`): the
// ones turned on for the caller, in both modes and whichever org they're in.
// `perms` is what those apps grant, for the client to gate UI.
export default defineEventHandler(async (event) => {
  const { userId } = requireAuth(event)
  const [enabled, perms] = await Promise.all([
    getUserEnabledApps(db, userId),
    getPersonalAppPermissions(db, userId)
  ])
  const apps = enabled
    .filter(a => !!a.path && (!a.requiredPermission || perms.has(a.requiredPermission as never)))
    .map(a => ({
      id: a.id,
      title: a.title,
      path: a.path!,
      icon: a.icon,
      description: a.description,
      requiredPermission: a.requiredPermission,
      order: a.order,
      scope: 'user' as const
    }))
  return { apps, perms: [...perms].sort() }
})
