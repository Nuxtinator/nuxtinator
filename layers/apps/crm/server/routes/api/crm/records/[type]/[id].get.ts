// GET /api/crm/records/:type/:id
// Hydrated record detail: every field materialized into `fields` (channel
// entries, connections, and user refs included), plus the caller's
// capability flags for this record — canEdit is the type update answer OR an
// edit-level share on this record; canShare/canDelete are type-level.
// Permission: the type evaluator's read answer plus the record-visibility
// rule — view_all, shared, or referenced through a user field; invisible
// records 404 like missing ones.

import { withOrgContext } from '#tenant/server'
import { accountOwnedChannelTypes } from '../../../../../utils/account-link'
import {
  assertRecordVisible,
  canUpdateRecord,
  getRecord,
  requireRecordType,
  requireTypePermission,
  resolveTypeCapabilities
} from '#crm/server'

export default defineEventHandler(async (event) => {
  const typeKey = getRouterParam(event, 'type')!
  const id = getRouterParam(event, 'id')!
  return await withOrgContext(event, { appId: 'crm' }, async (tx, ctx) => {
    await requireTypePermission(tx, ctx, typeKey, 'read')
    await requireRecordType(tx, typeKey)
    await assertRecordVisible(tx, ctx, typeKey, id)

    const record = await getRecord(tx, ctx, typeKey, id)
    const caps = await resolveTypeCapabilities(tx, ctx, typeKey)
    return {
      id: record.id,
      typeKey: record.recordType,
      name: record.name,
      status: record.status,
      fields: record.fields,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      createdBy: record.createdBy,
      userId: record.userId,
      accountOwnedChannelTypes: accountOwnedChannelTypes(record.userId),
      capabilities: {
        canEdit: await canUpdateRecord(tx, ctx, typeKey, id),
        canShare: caps.share,
        canDelete: caps.delete
      }
    }
  })
})
