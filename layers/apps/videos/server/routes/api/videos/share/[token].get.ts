// GET /api/videos/share/:token
// The watch page's video. Anyone can fetch a video with its public link on;
// the uploader can fetch their own at any visibility; signed-in members of
// the video's org can fetch org videos, and team videos when they're on the
// team. A signed-out request for a video they'd need to sign in for is 401,
// so the watch page can prompt sign-in (see `resolveSharedVideo`).

import { generateDownloadUrl } from '../../../../utils/video-storage'
import { resolveSharedVideo } from '../../../../utils/video-access'

export default defineEventHandler(async (event) => {
  const token = getRouterParam(event, 'token')
  if (!token) throw createError({ statusCode: 400, message: 'Share token is required' })

  const { video, isOwner } = await resolveSharedVideo(event, token)

  const filename = video.s3_key.split('/').pop()!
  const videoUrl = await generateDownloadUrl(filename)

  return {
    success: true,
    videoId: video.id,
    title: video.title,
    duration: video.duration,
    videoUrl,
    isOwner,
    viewCount: video.view_count,
    playCount: video.play_count
  }
})
