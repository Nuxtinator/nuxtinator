// GET /api/records/schema/permissions
// The registered record permission catalog (records.* plus each typed app's
// namespace, e.g. crm.*) with display meta, for the per-user extras picker.
// Backed by the runtime permission registry, so slugs registered by layers
// stacked on those namespaces (inbox) appear too. Returns { permissions: [{ key, title,
// description }] } sorted by key. Permission: records.schema.manage.

import { withOrgPermission } from '#tenant/server'
import { getAllPermissions, getPermissionMeta } from '#core/server/utils/permissions-registry'
import { isRecordsPermissionSlug } from '../../../../utils/user-grants'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'records' }, 'records.schema.manage', async () => {
    const permissions = getAllPermissions()
      .filter(isRecordsPermissionSlug)
      .sort()
      .map((key) => {
        const meta = getPermissionMeta(key)
        return { key, title: meta?.title ?? key, description: meta?.description ?? '' }
      })
    return { permissions }
  })
})
