// POST /api/videos/share/:token/view
// Mostly-public: bump view_count for a public or org video, skipping the
// owner's own views. Access mirrors share/[token].get.ts (public / owner /
// org member) — every request resolves the video's own org via
// withRecordOrgContext so RLS exposes it. An owner viewing their private video is a no-op, not an
// error.

import { sql } from 'kysely'
import { db } from '#core/server/utils/database'
import { getAuthUser } from '#core/server/utils/auth'
import { withRecordOrgContext, isActiveOrgMember } from '#tenant/server'

export default defineEventHandler(async (event) => {
  const token = getRouterParam(event, 'token')
  if (!token) throw createError({ statusCode: 400, message: 'Share token is required' })

  const auth = getAuthUser(event)

  const { video, isOrgMember } = await withRecordOrgContext(
    event,
    { table: 'videos', id: token, idColumn: 'share_token', validateUuid: false, notFoundMessage: 'Video not found' },
    async (tx) => {
      const video = await tx.selectFrom('videos')
        .select(['user_id', 'visibility'])
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
    // Anonymous callers can't tell a hidden video from a missing one.
    if (!auth) throw createError({ statusCode: 404, message: 'Video not found' })
    throw createError({ statusCode: 403, message: 'This video is private' })
  }

  // Public and org views count; the owner's own views never do. The SQL
  // function also filters on visibility, so a stale call can't bump a
  // video whose visibility changed underneath it.
  const shouldCount = !isOwner
    && (video.visibility === 'public' || video.visibility === 'org')
  if (shouldCount) {
    await sql`SELECT bump_video_counter(${token}, 'view')`.execute(db)
  }

  return { success: true, counted: shouldCount }
})
