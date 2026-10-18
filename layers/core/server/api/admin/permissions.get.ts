import { requireOperatorAdmin } from '#tenant/server'
import { getAllPermissions, getPermissionMeta } from '../../utils/permissions-registry'
import { getPersonalAppPermissionSlugs } from '../../utils/app-registry'

// Drives the custom-role permission picker. Returns the full set of
// currently-registered permissions (host static + every installed app
// layer) with optional metadata. The static `PERMISSIONS` import is no
// longer the source of truth on the client side — when a layer is
// uninstalled, its strings vanish here automatically (decision 9 — the
// admin UI hides orphaned permission strings entirely).
export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)

  // Personal-app permissions come from the app being on for a user, never a role.
  const personal = getPersonalAppPermissionSlugs()
  const perms = getAllPermissions().filter(p => !personal.has(p))
  const items = perms.map((perm) => {
    const meta = getPermissionMeta(perm)
    return {
      perm,
      title: meta?.title ?? perm,
      description: meta?.description ?? ''
    }
  })

  return { permissions: items }
})
