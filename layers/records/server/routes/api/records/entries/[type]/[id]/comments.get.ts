// GET /api/records/entries/:type/:id/comments?limit=&before=
// Newest-first keyset page of the record's comment stream. Returns
// { items: [{ id, authorId, authorName, body, createdAt, editedAt }],
//   nextCursor } — nextCursor is null on the last page. The activity stream
// is served separately (./activity.get.ts); the client merges the two into
// one timeline. Permission: the type evaluator's read answer plus the
// record-visibility rule.
//
// Relative utils imports: the new-in-this-milestone services are wired into
// the #crm/server barrel by the integrator, so routes reach them directly.

import { z } from 'zod'
import { withOrgContext } from '#tenant/server'
import { requireTypePermission } from '../../../../../../utils/type-permissions'
import { assertRecordVisible, requireRecordType } from '../../../../../../utils/list-records'
import { listComments } from '../../../../../../utils/comments'

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
    return await listComments(tx, id, parsed.data)
  })
})
