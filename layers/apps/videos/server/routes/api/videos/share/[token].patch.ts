// PATCH /api/videos/share/:token
// Rename a video from its watch page. The /watch/:token URL is org-exempt,
// so requests arrive with no active-org context and the regular
// `/api/videos/:id` PATCH can't be used. The video is reached the way the
// watch page reaches it (`resolveSharedVideo`), and only the uploader may
// rename it, matching the watch page, which shows the edit affordance to the
// uploader only.

import { sql } from 'kysely'
import { requireAuth } from '#core/server/utils/auth'
import { withRecordOrgContext } from '#tenant/server'
import { resolveSharedVideo } from '../../../../utils/video-access'

export default defineEventHandler(async (event) => {
  const token = getRouterParam(event, 'token')
  if (!token) throw createError({ statusCode: 400, message: 'Share token is required' })

  const auth = requireAuth(event)

  const body = await readBody(event)
  if (typeof body.title !== 'string' || body.title.trim() === '') {
    throw createError({ statusCode: 400, message: 'Valid title is required' })
  }
  const title = body.title.trim()

  const { video, isOwner } = await resolveSharedVideo(event, token)
  if (!isOwner) throw createError({ statusCode: 403, message: 'Forbidden' })

  return await withRecordOrgContext(
    event,
    { table: 'videos', id: token, idColumn: 'share_token', validateUuid: false, notFoundMessage: 'Video not found' },
    async (tx) => {
      await sql`select set_config('app.current_user', ${auth.userId}, true)`.execute(tx)
      const updated = await tx.updateTable('videos')
        .set({ title, updated_at: new Date() })
        .where('id', '=', video.id)
        .where('user_id', '=', auth.userId)
        .returningAll()
        .executeTakeFirst()
      if (!updated) throw createError({ statusCode: 404, message: 'Video not found' })

      return {
        success: true,
        video: {
          id: updated.id,
          title: updated.title,
          updatedAt: updated.updated_at
        }
      }
    }
  )
})
