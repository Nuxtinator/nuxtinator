// DELETE /api/records/schema/user-grants/:userId/:permission
// Revokes one direct crm.* grant. The crm.* prefix is enforced (this surface
// never touches other layers' grants) but registration is not — orphan slugs
// left by an uninstalled layer must stay revocable. Revoking a grant the
// user doesn't hold is a no-op. Returns the refreshed grants list.
// Permission: records.schema.manage.

import { withOrgPermission } from '#tenant/server'
import { revokeUserPermission } from '#core/server/utils/permission-grants'
import { assertRecordsPermissionSlug, listRecordsUserGrants, requireGrantTarget } from '#records/server'

export default defineEventHandler(async (event) => {
  const userId = getRouterParam(event, 'userId')!
  const permission = getRouterParam(event, 'permission')!
  return await withOrgPermission(event, 'records.schema.manage', async (tx, ctx) => {
    assertRecordsPermissionSlug(permission)
    await requireGrantTarget(tx, ctx, userId)
    await revokeUserPermission(tx, ctx, userId, permission)
    return { items: await listRecordsUserGrants(tx, userId) }
  })
})
