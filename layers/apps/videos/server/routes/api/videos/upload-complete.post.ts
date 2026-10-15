// POST /api/videos/upload-complete
// Persists video metadata after the browser has uploaded the file to S3.
// The object keys must be the ones upload-url derives from videoId, and the
// row's primary key is that videoId, so a caller can only claim objects under
// a fresh id — never another video's file.

import { randomBytes } from 'crypto'
import { withOrgContext } from '#tenant/server'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'webm', 'avi']

export default defineEventHandler(async (event) => {
  return await withOrgContext(event, { appId: 'videos' }, async (tx, ctx) => {
    const body = await readBody(event)
    const {
      videoId,
      videoKey,
      thumbnailKey,
      duration,
      fileSize,
      width,
      height,
      source = 'recording',
      originalFilename,
      originalFileSize,
      compressionRatio,
      visibility
    } = body

    if (!videoId || !videoKey) {
      throw createError({ statusCode: 400, message: 'videoId and videoKey are required' })
    }
    if (typeof videoId !== 'string' || !UUID_RE.test(videoId)) {
      throw createError({ statusCode: 400, message: 'Invalid videoId' })
    }
    if (!VIDEO_EXTENSIONS.some(ext => videoKey === `${videoId}.${ext}`)) {
      throw createError({ statusCode: 400, message: 'videoKey does not match videoId' })
    }
    if (thumbnailKey && thumbnailKey !== `${videoId}-thumb.jpg`) {
      throw createError({ statusCode: 400, message: 'thumbnailKey does not match videoId' })
    }

    const resolvedVisibility: 'private' | 'org' | 'public' =
      visibility === 'public' || visibility === 'org' || visibility === 'private'
        ? visibility
        : 'private'

    const shareToken = randomBytes(16).toString('hex')

    const now = new Date()
    const datePart = now.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    const timePart = now.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
      .toLowerCase().replace(/\s/g, '')
    const title = `${datePart} ${timePart}`

    const s3Key = `videos/${videoKey}`
    const thumbnailS3Key = thumbnailKey ? `videos/${thumbnailKey}` : null

    const inserted = await tx
      .insertInto('videos')
      .values({
        id: videoId,
        user_id: ctx.userId,
        title,
        s3_key: s3Key,
        thumbnail_url: thumbnailS3Key,
        duration: duration || 0,
        file_size: fileSize ?? null,
        width: width ?? null,
        height: height ?? null,
        share_token: shareToken,
        visibility: resolvedVisibility,
        source,
        original_filename: originalFilename ?? null,
        original_file_size: originalFileSize ?? null,
        compression_ratio: compressionRatio ?? null
      } as never)
      .returningAll()
      .executeTakeFirstOrThrow()

    return {
      success: true,
      videoId: inserted.id,
      shareToken: inserted.share_token
    }
  })
})
