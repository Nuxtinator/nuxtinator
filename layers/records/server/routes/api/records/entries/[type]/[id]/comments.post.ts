// POST /api/records/entries/:type/:id/comments
// Body: { body } (1..10000 chars). Adds a comment authored by the caller and
// returns it ({ id, authorId, authorName, body, createdAt, editedAt }).
// Comments are their own timeline stream — no activity row is written.
// Permission: the type evaluator's read answer plus the record-visibility
// rule — anyone who can see the record can comment on it.

import { z } from 'zod'
import { withOrgContext } from '#tenant/server'
import { requireTypePermission } from '../../../../../../utils/type-permissions'
import { assertRecordVisible, requireRecordType } from '../../../../../../utils/list-records'
import { addComment } from '../../../../../../utils/comments'

const Body = z.object({
  body: z.string().min(1).max(10000)
})

export default defineEventHandler(async (event) => {
  const typeKey = getRouterParam(event, 'type')!
  const id = getRouterParam(event, 'id')!
  return await withOrgContext(event, async (tx, ctx) => {
    await requireTypePermission(tx, ctx, typeKey, 'read')
    await requireRecordType(tx, typeKey, ctx)
    await assertRecordVisible(tx, ctx, typeKey, id)

    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }
    return await addComment(tx, ctx, id, { body: parsed.data.body })
  })
})
