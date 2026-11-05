// DELETE /api/records/entries/:type/:id
// Hard delete — satellite rows cascade away with the record, so nothing is
// written to the (record-keyed) activity timeline. Permission: the type
// evaluator's delete answer plus the record-visibility rule. Delete has no
// share-level equivalent — an edit share never grants it.

import { withOrgContext } from '#tenant/server'
import { assertRecordVisible, deleteRecord, requireRecordType, requireTypePermission } from '#records/server'

export default defineEventHandler(async (event) => {
  const typeKey = getRouterParam(event, 'type')!
  const id = getRouterParam(event, 'id')!
  return await withOrgContext(event, async (tx, ctx) => {
    await requireTypePermission(tx, ctx, typeKey, 'delete')
    await requireRecordType(tx, typeKey)
    await assertRecordVisible(tx, ctx, typeKey, id)
    await deleteRecord(tx, ctx, typeKey, id)
    return { ok: true }
  })
})
