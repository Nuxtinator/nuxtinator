// GET /api/videos?scope=mine|team
//
// scope=mine (default) — videos uploaded by the current user, every visibility
// scope=team           — team and org videos in the active org that the
//                        caller may see: org videos, their teams' videos and
//                        their own (every team's with "show all teams")
//
// Other people's private videos never reach this route: RLS hides them.

import { withOrgContext } from '#tenant/server'
import { teamVisible } from '#core/server/utils/team-access'
import { generateDownloadUrl } from '../../../utils/video-storage'
import { getVideosTeamScope, withVideoTeams } from '../../../utils/video-access'

export default defineEventHandler(async (event) => {
  return await withOrgContext(event, { appId: 'videos' }, async (tx, ctx) => {
    const query = getQuery(event)
    const scope = query.scope === 'team' ? 'team' : 'mine'

    let q = tx.selectFrom('videos').selectAll()

    if (scope === 'team') {
      const teamScope = await getVideosTeamScope(event, tx, ctx)
      q = q.where('visibility', 'in', ['team', 'org']).where(teamVisible(teamScope, 'videos'))
    } else {
      q = q.where('user_id', '=', ctx.userId)
    }

    const rows = await withVideoTeams(tx, await q.orderBy('created_at', 'desc').execute())

    const videos = await Promise.all(rows.map(async ({ row: v, team }) => {
      let thumbnailUrl: string | null = null
      if (v.thumbnail_url) {
        try {
          const filename = v.thumbnail_url.split('/').pop()!
          thumbnailUrl = await generateDownloadUrl(filename)
        } catch (err) {
          console.error('Error generating thumbnail URL:', err)
        }
      }
      return {
        id: v.id,
        title: v.title,
        duration: v.duration,
        fileSize: v.file_size,
        width: v.width,
        height: v.height,
        thumbnailUrl,
        shareToken: v.share_token,
        visibility: v.visibility,
        team,
        linkEnabled: v.link_enabled,
        viewCount: v.view_count,
        playCount: v.play_count,
        userId: v.user_id,
        createdAt: v.created_at,
        updatedAt: v.updated_at
      }
    }))

    return { videos }
  })
})
