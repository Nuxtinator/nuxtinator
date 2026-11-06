// GET /api/records/schema/types/:type/role-grants
// The per-type role matrix for the settings UI: the record actions, the
// org's assignable roles (static + custom, admin included), the stored
// override rows (config.roleGrants), and the per-role effective answers —
// { allowed, source: 'row' | 'slug' | 'admin', fallback } — computed with
// the evaluator's fallback logic so Inherit cells render honestly.
// Permission: records.schema.manage.

import { withOrgPermission } from '#tenant/server'
import { buildRoleGrantsView, getRecordType } from '#records/server'

export default defineEventHandler(async (event) => {
  const typeKey = getRouterParam(event, 'type')!
  return await withOrgPermission(event, { appId: 'records' }, 'records.schema.manage', async (tx, ctx) => {
    const type = await getRecordType(tx, typeKey)
    // Orphan rows have no live routes to gate — nothing to grant against.
    if (!type || type.orphan) {
      throw createError({ statusCode: 404, statusMessage: `Unknown record type: ${typeKey}` })
    }
    return await buildRoleGrantsView(tx, ctx, type)
  })
})
