// POST /api/files/uploads
// multipart/form-data with a "file" field (plus optional "title"/"tags").
// Uploads the binary to S3 (private) and creates an immutable kind='file' item.

import { withOrgPermission } from '#tenant/server'
import { uploadToS3, validateFileSize } from '#core/server/utils/storage'
import { logCreate } from '#core/server/utils/activity-logger'
import { normalizeTags, MAX_FILE_MB } from '../../../utils/file-helpers'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'files' }, 'files.write', async (tx, ctx) => {
    const parts = await readMultipartFormData(event)
    if (!parts) {
      throw createError({ statusCode: 400, statusMessage: 'Expected multipart/form-data.' })
    }

    const filePart = parts.find(p => p.name === 'file' && p.filename)
    if (!filePart) {
      throw createError({ statusCode: 400, statusMessage: 'No "file" field in upload.' })
    }

    const data = filePart.data
    const originalFilename = filePart.filename ?? 'upload'
    const contentType = filePart.type ?? 'application/octet-stream'

    if (!validateFileSize(data.byteLength, MAX_FILE_MB)) {
      throw createError({ statusCode: 413, statusMessage: `File too large (max ${MAX_FILE_MB} MB).` })
    }

    const titlePart = parts.find(p => p.name === 'title')
    const title = titlePart ? titlePart.data.toString('utf8').trim() : ''
    const tagsPart = parts.find(p => p.name === 'tags')
    const tags = tagsPart ? parseTags(tagsPart.data.toString('utf8')) : []

    const result = await uploadToS3(Buffer.from(data), originalFilename, contentType, 'private', 'files')

    const item = await tx
      .insertInto('files_items')
      .values({
        kind: 'file',
        title: title || originalFilename,
        storage_key: result.key,
        filename: originalFilename,
        mime: contentType,
        size_bytes: data.byteLength,
        tags,
        created_by: ctx.userId
      })
      .returning(['id', 'kind', 'title', 'filename', 'mime', 'size_bytes', 'tags', 'created_at'])
      .executeTakeFirstOrThrow()

    logCreate('files_items', item.id, ctx.userId, { kind: 'file', mime: contentType })

    return { item }
  })
})

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return normalizeTags(parsed)
  } catch {
    // not JSON — fall through to comma-split
  }
  return normalizeTags(raw.split(','))
}
