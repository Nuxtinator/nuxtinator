// DELETE /api/videos/:id
// Removes the video row and best-effort deletes the S3 objects. The uploader
// deletes their own; users with `videos.moderate` can delete any team or org
// video they can see.

import { withOrgContext } from '#tenant/server'
import { deleteVideoObject } from '../../../utils/video-storage'
import { getVideosTeamScope, loadVisibleVideo } from '../../../utils/video-access'

export default defineEventHandler(async (event) => {
  return await withOrgContext(event, { appId: 'videos' }, async (tx, ctx) => {
    const id = getRouterParam(event, 'id')
    if (!id) throw createError({ statusCode: 400, message: 'Video id is required' })

    const existing = await loadVisibleVideo(tx, await getVideosTeamScope(event, tx, ctx), id)

    const isOwner = existing.user_id === ctx.userId
    if (!isOwner && !ctx.perms.has('videos.moderate')) {
      throw createError({ statusCode: 403, message: 'Forbidden' })
    }

    // Best-effort S3 cleanup before the row is gone — failures don't block delete.
    for (const key of [existing.s3_key, existing.thumbnail_url]) {
      if (!key) continue
      try {
        const stripped = key.startsWith('videos/') ? key.slice('videos/'.length) : key
        await deleteVideoObject(stripped)
      } catch (err) {
        console.error('Error deleting S3 object', key, err)
      }
    }

    await tx.deleteFrom('videos').where('id', '=', id).execute()

    return { success: true }
  })
})
