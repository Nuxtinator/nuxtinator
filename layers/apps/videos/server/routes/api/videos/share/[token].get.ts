// GET /api/videos/share/:token
// Mostly-public: anyone (authed or not) can fetch a `visibility='public'`
// video. Authenticated members of the video's org can additionally fetch
// `visibility='org'` videos, and owners can fetch their own videos at any
// visibility — useful right after upload when the recorder UI hands the user
// the share link before they've decided whether to publish.
//
// Implementation — the `/watch/:token` URL is org-exempt, so requests arrive
// with no active-org context regardless of who's asking. Every request
// resolves the video's *own* org from the token via `withRecordOrgContext`
// (BYPASSRLS lookup + GUC set) so RLS exposes the row, then the public /
// owner / org-member rule is enforced in application code
// (`isActiveOrgMember` answers "member of the video's org?" against the GUC
// the helper just set; always true in single mode). Anonymous requests for
// an org link get a 401 so the watch page can prompt sign-in; anonymous
// requests for a private link get the same 404 as an unknown token, so
// private links don't confirm their existence.

import { generateDownloadUrl } from '../../../../utils/video-storage'
import { getAuthUser } from '#core/server/utils/auth'
import { withRecordOrgContext, isActiveOrgMember } from '#tenant/server'

const SELECT_COLS = [
  'id', 'user_id', 'title', 's3_key', 'duration', 'file_size',
  'width', 'height', 'thumbnail_url', 'visibility',
  'view_count', 'play_count', 'created_at'
] as const

export default defineEventHandler(async (event) => {
  const token = getRouterParam(event, 'token')
  if (!token) throw createError({ statusCode: 400, message: 'Share token is required' })

  const auth = getAuthUser(event)

  const { video, isOrgMember } = await withRecordOrgContext(
    event,
    { table: 'videos', id: token, idColumn: 'share_token', validateUuid: false, notFoundMessage: 'Video not found' },
    async (tx) => {
      const video = await tx.selectFrom('videos')
        .select(SELECT_COLS)
        .where('share_token', '=', token)
        .executeTakeFirst()
      const isOrgMember = video && auth ? await isActiveOrgMember(tx, auth.userId) : false
      return { video, isOrgMember }
    }
  )

  if (!video) throw createError({ statusCode: 404, message: 'Video not found' })

  const isOwner = auth?.userId === video.user_id
  const canView = video.visibility === 'public' || isOwner
    || (video.visibility === 'org' && isOrgMember)
  if (!canView) {
    if (!auth) {
      // Org links circulate inside the org, so confirming one exists is
      // fine — prompt sign-in. Private links stay indistinguishable from
      // nonexistent ones.
      if (video.visibility === 'org') {
        throw createError({ statusCode: 401, message: 'Sign in to watch this video' })
      }
      throw createError({ statusCode: 404, message: 'Video not found' })
    }
    throw createError({ statusCode: 403, message: 'This video is private' })
  }

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
