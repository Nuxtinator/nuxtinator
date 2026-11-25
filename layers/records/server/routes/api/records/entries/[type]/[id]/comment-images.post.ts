// POST /api/records/entries/:type/:id/comment-images
// multipart/form-data with one or more "file" parts, each a PNG, JPEG, GIF,
// WebP or AVIF image. Stores them on the record for a comment the caller is
// writing and returns { files }, the files added. Posting or saving a comment
// that shows one keeps it (see utils/comments.ts). Permission: the same as
// adding a comment.

import { withOrgContext } from '#tenant/server'
import { requireTypePermission } from '../../../../../../utils/type-permissions'
import { assertRecordVisible, requireRecordType } from '../../../../../../utils/list-records'
import { addCommentImage } from '../../../../../../utils/comments'

export default defineEventHandler(async (event) => {
  const typeKey = getRouterParam(event, 'type')!
  const id = getRouterParam(event, 'id')!
  return await withOrgContext(event, async (tx, ctx) => {
    await requireTypePermission(tx, ctx, typeKey, 'read')
    await requireRecordType(tx, typeKey, ctx)
    await assertRecordVisible(tx, ctx, typeKey, id)

    const parts = (await readMultipartFormData(event))?.filter(p => p.name === 'file' && p.filename) ?? []
    if (parts.length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No "file" field in upload.' })
    }
    const files = []
    for (const part of parts) {
      files.push(await addCommentImage(tx, ctx, id, {
        data: Buffer.from(part.data),
        filename: part.filename ?? 'image',
        mime: part.type ?? 'application/octet-stream'
      }))
    }
    return { files }
  })
})
