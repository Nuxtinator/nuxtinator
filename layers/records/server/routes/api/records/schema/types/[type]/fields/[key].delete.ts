// DELETE /api/records/schema/types/:type/fields/:key
// Custom and stale (orphan) fields: deletes the definition row — any stored
// values in data/entries become orphans the readers tolerate. Manifest
// fields: clears the override row instead, restoring code defaults (400 when
// no override exists). Permission: records.schema.manage.

import { withOrgPermission } from '#tenant/server'
import { deleteField } from '#records/server'

export default defineEventHandler(async (event) => {
  const typeKey = getRouterParam(event, 'type')!
  const fieldKey = getRouterParam(event, 'key')!
  return await withOrgPermission(event, { appId: 'records' }, 'records.schema.manage', async (tx, ctx) => {
    await deleteField(tx, ctx, typeKey, fieldKey)
    return { ok: true }
  })
})
