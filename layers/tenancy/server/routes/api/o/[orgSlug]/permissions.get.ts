import { withOrgPermission } from '#tenant/server'
import { getAllPermissions, getPermissionMeta } from '#core/server/utils/permissions-registry'
import { getPersonalAppPermissionSlugs, getRegisteredApps } from '#core/server/utils/app-registry'

// Org-scoped variant of `/api/admin/permissions`. Returns the full set of
// runtime-registered permissions for the role / override pickers. Layer
// uninstalls drop their permission strings here automatically.
//
// Each permission carries a `group` — its prefix before the first dot, which
// matches the owning app's id — and `groups` lists them in display order:
// org permissions first, then apps in launcher order.
export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, 'org.roles.read', async () => {
    // Personal-app permissions come from the app being on for a user, never a role.
    const personal = getPersonalAppPermissionSlugs()
    const perms = getAllPermissions().filter(p => !personal.has(p))
    const apps = getRegisteredApps()
    const groupOf = (perm: string) => perm.split('.')[0]!

    const groupIds = new Set(perms.map(groupOf))
    const groups = [
      ...(groupIds.has('org') ? [{ id: 'org', title: 'Organization', icon: 'i-lucide-building-2' }] : []),
      ...apps.filter(a => groupIds.has(a.id)).map(a => ({ id: a.id, title: a.title, icon: a.icon })),
      ...[...groupIds]
        .filter(id => id !== 'org' && !apps.some(a => a.id === id))
        .sort()
        .map(id => ({ id, title: id, icon: undefined }))
    ]

    return {
      groups,
      permissions: perms.map((perm) => {
        const meta = getPermissionMeta(perm)
        return {
          perm,
          group: groupOf(perm),
          title: meta?.title ?? perm,
          description: meta?.description ?? ''
        }
      })
    }
  })
})
