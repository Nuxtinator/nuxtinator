// PATCH /api/videos/:id
// Update a video's title, audience (`visibility` private | team | org, with
// `teamId` for team) and/or public link (`linkEnabled`). The uploader edits
// their own; `videos.moderate` edits anyone's team and org videos. Only the
// uploader can make a video private, and a team must be one the caller is on.

import { withOrgContext } from '#tenant/server'
import {
  assertPickableTeam,
  getVideosTeamScope,
  loadVisibleVideo,
  readVideoAudience,
  withVideoTeams
} from '../../../utils/video-access'

export default defineEventHandler(async (event) => {
  return await withOrgContext(event, { appId: 'videos' }, async (tx, ctx) => {
    const id = getRouterParam(event, 'id')
    if (!id) throw createError({ statusCode: 400, message: 'Video id is required' })

    const body = (await readBody(event)) ?? {}
    const updates: { title?: string, visibility?: 'private' | 'team' | 'org', team_id?: string | null, link_enabled?: boolean } = {}

    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || body.title.trim() === '') {
        throw createError({ statusCode: 400, message: 'Valid title is required' })
      }
      updates.title = body.title.trim()
    }

    const audience = readVideoAudience(body)
    if (audience) {
      updates.visibility = audience.visibility
      updates.team_id = audience.teamId
      if (audience.linkOn) updates.link_enabled = true
    }

    if (body.linkEnabled !== undefined) {
      if (typeof body.linkEnabled !== 'boolean') {
        throw createError({ statusCode: 400, message: 'linkEnabled must be true or false' })
      }
      updates.link_enabled = body.linkEnabled
    }

    if (Object.keys(updates).length === 0) {
      throw createError({ statusCode: 400, message: 'No updates provided' })
    }

    const scope = await getVideosTeamScope(event, tx, ctx)
    const existing = await loadVisibleVideo(tx, scope, id)

    const isOwner = existing.user_id === ctx.userId
    if (!isOwner && !ctx.perms.has('videos.moderate')) {
      throw createError({ statusCode: 403, message: 'Forbidden' })
    }
    if (updates.visibility === 'private' && !isOwner) {
      throw createError({ statusCode: 403, message: 'Only the uploader can make a video private' })
    }
    if (updates.team_id && updates.team_id !== existing.team_id) {
      await assertPickableTeam(tx, scope, updates.team_id)
    }

    const updated = await tx.updateTable('videos')
      .set({ ...updates, updated_at: new Date() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow()
    const team = (await withVideoTeams(tx, [updated]))[0]!.team

    return {
      success: true,
      video: {
        id: updated.id,
        title: updated.title,
        visibility: updated.visibility,
        team,
        linkEnabled: updated.link_enabled,
        updatedAt: updated.updated_at
      }
    }
  })
})
