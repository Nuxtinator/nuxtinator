// GET /api/records/entries/:type/:id/mentions
// The records whose rich text links to this one ("#" chips), latest change
// first: { items: [{ id, typeKey, name }] }. Only records the caller may open
// are listed. Permission: the type evaluator's read answer plus the
// record-visibility rule, like the record itself.

import { withOrgContext } from '#tenant/server'
import {
  assertRecordVisible,
  recordsNamesOf,
  requireRecordType,
  requireTypePermission
} from '#records/server'

export default defineEventHandler(async (event) => {
  const typeKey = getRouterParam(event, 'type')!
  const id = getRouterParam(event, 'id')!
  return await withOrgContext(event, async (tx, ctx) => {
    await requireTypePermission(tx, ctx, typeKey, 'read')
    await requireRecordType(tx, typeKey, ctx)
    await assertRecordVisible(tx, ctx, typeKey, id)

    const rows = await tx
      .selectFrom('records_mentions')
      .select('from_record_id')
      .distinct()
      .where('to_record_id', '=', id)
      .execute()
    return { items: await recordsNamesOf(tx, ctx, rows.map(row => row.from_record_id)) }
  })
})
