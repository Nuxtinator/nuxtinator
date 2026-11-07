// DELETE /api/records/schema/types/:type
// Deletes an admin-created record type (or a stale orphan row) along with
// its records_fields rows. Code-declared types 400 (hide or revert them
// instead); types that still have records 409. Permission: records.schema.manage.

import { withOrgPermission } from '#tenant/server'
import { deleteRecordType } from '#records/server'

export default defineEventHandler(async (event) => {
  const typeKey = getRouterParam(event, 'type')!
  return await withOrgPermission(event, { appId: 'records' }, 'records.schema.manage', async (tx, ctx) => {
    await deleteRecordType(tx, ctx, typeKey)
    return { ok: true }
  })
})
