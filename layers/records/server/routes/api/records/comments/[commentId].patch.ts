// PATCH /api/records/comments/:commentId
// Body: { body } (1..10000 chars). Edits a comment and returns it
// ({ id, authorId, authorName, body, createdAt, editedAt }).
//
// Author-or-moderator rule: the author may edit their own comment; a caller
// with the type evaluator's delete answer (the moderator bar) may edit
// anyone's. The type-scoped permissions depend on the comment's record, so
// after loading the comment the route checks the record type's app gate, the
// record-visibility rule and the record-scoped update gate (type update
// answer OR an edit-level share).

import { z } from 'zod'
import { withOrgContext } from '#tenant/server'
import { requireRecordUpdate, resolveTypePermission } from '../../../../utils/type-permissions'
import { assertRecordVisible, requireRecordType } from '../../../../utils/list-records'
import { getCommentRecord, updateComment } from '../../../../utils/comments'

const Body = z.object({
  body: z.string().min(1).max(10000)
})

export default defineEventHandler(async (event) => {
  const commentId = getRouterParam(event, 'commentId')!
  return await withOrgContext(event, async (tx, ctx) => {
    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }

    const ref = await getCommentRecord(tx, commentId)
    if (!ref) {
      throw createError({ statusCode: 404, statusMessage: 'Comment not found.' })
    }
    await requireRecordType(tx, ref.recordType, ctx)
    await assertRecordVisible(tx, ctx, ref.recordType, ref.recordId)
    await requireRecordUpdate(tx, ctx, ref.recordType, ref.recordId)

    const canModerate = await resolveTypePermission(tx, ctx, ref.recordType, 'delete')
    return await updateComment(tx, ctx, commentId, parsed.data.body, { canModerate })
  })
})
