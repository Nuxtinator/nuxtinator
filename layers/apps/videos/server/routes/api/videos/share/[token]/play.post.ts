// POST /api/videos/share/:token/play
// Bump play_count when a viewer finishes most of a video. Whoever may watch
// it (`resolveSharedVideo`) may count a play; the `bump_video_counter` SQL
// function (security definer, so a signed-out viewer can write) counts only
// videos with their link on or shared with a team or the org.

import { sql } from 'kysely'
import { db } from '#core/server/utils/database'
import { resolveSharedVideo } from '../../../../../utils/video-access'

export default defineEventHandler(async (event) => {
  const token = getRouterParam(event, 'token')
  if (!token) throw createError({ statusCode: 400, message: 'Share token is required' })

  await resolveSharedVideo(event, token)
  await sql`SELECT bump_video_counter(${token}, 'play')`.execute(db)

  return { success: true }
})
