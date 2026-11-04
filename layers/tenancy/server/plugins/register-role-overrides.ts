// Applies each org's `org_role_overrides` (grant/revoke per static role) to
// the role sets `getRolePermissions` builds for that org. Read through
// adminDb with an explicit org filter, so the result doesn't depend on which
// org the caller's transaction is scoped to.
import { registerRoleOverlay } from '#core/server/utils/role-overlay-registry'
import { isRegisteredPermission } from '#core/server/utils/permissions-registry'
import { adminDb } from '../utils/database-admin'

export default defineNitroPlugin(() => {
  registerRoleOverlay(async (orgId, perRole) => {
    if (perRole.size === 0) return
    const rows = await adminDb
      .selectFrom('org_role_overrides')
      .select(['role_name', 'permission', 'effect'])
      .where('org_id', '=', orgId)
      .where('role_name', 'in', [...perRole.keys()])
      .execute()
    for (const row of rows) {
      const perms = perRole.get(row.role_name)
      if (!perms) continue
      if (row.effect === 'revoke') perms.delete(row.permission)
      else if (isRegisteredPermission(row.permission)) perms.add(row.permission)
    }
  })
})
