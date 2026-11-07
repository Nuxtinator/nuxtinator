// DELETE /api/records/comments/:commentId
// Deletes a comment; returns { ok: true }.
//
// Author-or-moderator rule: the author may delete their own comment; a caller
// with the type evaluator's delete answer (the moderator bar) may delete
// anyone's. The type-scoped permissions depend on the comment's record, so
// after loading the comment the route checks the record type's app gate and
// the record-visibility rule — the same bar as adding a comment.

import { withOrgContext } from '#tenant/server'
import { resolveTypePermission } from '../../../../utils/type-permissions'
import { assertRecordVisible, requireRecordType } from '../../../../utils/list-records'
import { deleteComment, getCommentRecord } from '../../../../utils/comments'

export default defineEventHandler(async (event) => {
  const commentId = getRouterParam(event, 'commentId')!
  return await withOrgContext(event, async (tx, ctx) => {
    const ref = await getCommentRecord(tx, commentId)
    if (!ref) {
      throw createError({ statusCode: 404, statusMessage: 'Comment not found.' })
    }
    await requireRecordType(tx, ref.recordType, ctx)
    await assertRecordVisible(tx, ctx, ref.recordType, ref.recordId)

    const canModerate = await resolveTypePermission(tx, ctx, ref.recordType, 'delete')
    await deleteComment(tx, ctx, commentId, { canModerate })
    return { ok: true }
  })
})
