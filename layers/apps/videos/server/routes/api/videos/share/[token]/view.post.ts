// POST /api/videos/share/:token/view
// Bump view_count for whoever may watch the video (`resolveSharedVideo`),
// skipping the uploader's own views. The `bump_video_counter` SQL function
// counts only videos with their link on or shared with a team or the org,
// so viewing your own private video is a no-op, not an error.

import { sql } from 'kysely'
import { db } from '#core/server/utils/database'
import { resolveSharedVideo } from '../../../../../utils/video-access'

export default defineEventHandler(async (event) => {
  const token = getRouterParam(event, 'token')
  if (!token) throw createError({ statusCode: 400, message: 'Share token is required' })

  const { video, isOwner } = await resolveSharedVideo(event, token)
  const shouldCount = !isOwner && (video.link_enabled || video.visibility !== 'private')
  if (shouldCount) {
    await sql`SELECT bump_video_counter(${token}, 'view')`.execute(db)
  }

  return { success: true, counted: shouldCount }
})
