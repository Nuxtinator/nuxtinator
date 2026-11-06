// GET /api/records/entries/:type/:id/activity?limit=&before=
// Newest-first keyset page of the record's display timeline. Returns
// { items: [{ id, action, fieldKey, oldValue, newValue, note, actorUserId,
//   actorName, createdAt }], nextCursor } — nextCursor is null on the last
// page. The comment stream is served separately (./comments.get.ts); the
// client merges the two into one timeline. Permission: the type evaluator's
// read answer plus the record-visibility rule.

import { z } from 'zod'
import { withOrgContext } from '#tenant/server'
import { requireTypePermission } from '../../../../../../utils/type-permissions'
import { assertRecordVisible, requireRecordType } from '../../../../../../utils/list-records'
import { listActivity } from '../../../../../../utils/activity'

const Query = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  before: z.string().optional()
})

export default defineEventHandler(async (event) => {
  const typeKey = getRouterParam(event, 'type')!
  const id = getRouterParam(event, 'id')!
  return await withOrgContext(event, async (tx, ctx) => {
    await requireTypePermission(tx, ctx, typeKey, 'read')
    await requireRecordType(tx, typeKey, ctx)
    await assertRecordVisible(tx, ctx, typeKey, id)

    const parsed = Query.safeParse(getQuery(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid query', data: parsed.error.flatten() })
    }
    return await listActivity(tx, id, parsed.data)
  })
})
