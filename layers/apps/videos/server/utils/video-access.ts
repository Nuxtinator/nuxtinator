// Who sees a video. `private` videos are RLS's: only their uploader's
// transaction (or a share-link read of a video with its link on) sees them.
// `team` videos go through core's team-access helper; `org` videos are the
// whole org's. The public link (`link_enabled`) opens a video to anyone with
// its share token, whatever its visibility.

import type { H3Event } from 'h3'
import { sql, type Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { Permission } from '#core/app/utils/permissions'
import { getAuthUser } from '#core/server/utils/auth'
import {
  canSeeContainer,
  getContainerTeams,
  getMemberTeamScope,
  getTeamScope,
  type TeamScope
} from '#core/server/utils/team-access'
import { withRecordOrgContext, isActiveOrgMember } from '#tenant/server'
import type { VideoVisibility } from '../database/schema.d'

type Tx = Transaction<Database>

export const VIDEO_VISIBILITIES: VideoVisibility[] = ['private', 'team', 'org']

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function getVideosTeamScope(
  event: H3Event,
  tx: Tx,
  ctx: { userId: string, orgId: string | null, perms: Set<Permission> }
): Promise<TeamScope> {
  return getTeamScope(event, tx, ctx, 'videos')
}

// 404 unless the video exists for this transaction and the caller may see it.
export async function loadVisibleVideo(tx: Tx, scope: TeamScope, id: string) {
  const video = UUID_RE.test(id)
    ? await tx.selectFrom('videos').selectAll().where('id', '=', id).executeTakeFirst()
    : undefined
  if (!video || !(await canSeeContainer(tx, scope, 'videos', id))) {
    throw createError({ statusCode: 404, statusMessage: 'Video not found' })
  }
  return video
}

export interface VideoAudienceInput {
  visibility: VideoVisibility
  teamId: string | null
}

// Reads `{ visibility, teamId }` from a request body. `public` is the old
// name for an org video with its link on. Undefined when the body names
// neither.
export function readVideoAudience(body: { visibility?: unknown, teamId?: unknown }): (VideoAudienceInput & { linkOn: boolean }) | undefined {
  if (body.visibility === undefined && body.teamId === undefined) return undefined
  if (body.visibility === 'public') return { visibility: 'org', teamId: null, linkOn: true }
  if (!VIDEO_VISIBILITIES.includes(body.visibility as VideoVisibility)) {
    throw createError({ statusCode: 400, statusMessage: 'visibility must be private, team or org' })
  }
  const visibility = body.visibility as VideoVisibility
  if (visibility !== 'team') {
    if (body.teamId !== undefined && body.teamId !== null) {
      throw createError({ statusCode: 400, statusMessage: 'teamId is only for team videos' })
    }
    return { visibility, teamId: null, linkOn: false }
  }
  if (typeof body.teamId !== 'string' || !UUID_RE.test(body.teamId)) {
    throw createError({ statusCode: 400, statusMessage: 'Pick a team' })
  }
  return { visibility, teamId: body.teamId, linkOn: false }
}

// A video goes to one of the caller's own live teams, and only while the
// org's groups run as teams.
export async function assertPickableTeam(tx: Tx, scope: TeamScope, teamId: string): Promise<void> {
  if (scope.mode !== 'teams') {
    throw createError({ statusCode: 400, statusMessage: 'Teams are off here, so videos can\'t be limited to them.' })
  }
  if (!scope.teamIds.includes(teamId)) {
    throw createError({ statusCode: 403, statusMessage: 'You can only share a video with a team you are on.' })
  }
  const live = await tx
    .selectFrom('groups')
    .select('id')
    .where('id', '=', teamId)
    .where('archived_at', 'is', null)
    .executeTakeFirst()
  if (!live) throw createError({ statusCode: 400, statusMessage: 'Unknown or archived team' })
}

// Adds each team video's team name for display.
export async function withVideoTeams<T extends { id: string, team_id: string | null }>(tx: Tx, rows: T[]) {
  const teams = await getContainerTeams(tx, 'videos', rows.filter(r => r.team_id).map(r => r.id))
  return rows.map(r => ({ row: r, team: teams.get(r.id)?.[0] ?? null }))
}

const SHARE_COLS = [
  'id', 'user_id', 'title', 's3_key', 'duration', 'visibility', 'link_enabled',
  'view_count', 'play_count'
] as const

// A video reached by its share token, the way `/watch/:token` reaches it:
// in its own org (single mode: the one tenant), with `app.videos_link` set to
// the token and `app.current_user` to a signed-in caller, so RLS shows a
// private video only to its uploader or, with its link on, to anyone.
//
// Link on, or the caller's own: open. Otherwise signed out is 401 (sign in),
// another org's member 403, and a team video off the caller's teams 404.
// A video RLS hides is 404, or 401 when signed out in single mode, where a
// signed-out viewer sees only link videos and a hidden one could be any.
export async function resolveSharedVideo(event: H3Event, token: string) {
  const auth = getAuthUser(event)
  return await withRecordOrgContext(
    event,
    { table: 'videos', id: token, idColumn: 'share_token', validateUuid: false, notFoundMessage: 'Video not found' },
    async (tx) => {
      await sql`select set_config('app.videos_link', ${token}, true)`.execute(tx)
      if (auth) await sql`select set_config('app.current_user', ${auth.userId}, true)`.execute(tx)
      const orgId = (await sql<{ org: string | null }>`
        select nullif(current_setting('app.current_org', true), '') as org
      `.execute(tx)).rows[0]?.org ?? null

      const video = await tx.selectFrom('videos').select(SHARE_COLS).where('share_token', '=', token).executeTakeFirst()
      if (!video) {
        if (!auth && !orgId) throw createError({ statusCode: 401, statusMessage: 'Sign in to watch this video' })
        throw createError({ statusCode: 404, statusMessage: 'Video not found' })
      }

      const isOwner = !!auth && video.user_id === auth.userId
      if (video.link_enabled || isOwner) return { video, isOwner }
      if (!auth) throw createError({ statusCode: 401, statusMessage: 'Sign in to watch this video' })
      if (!(await isActiveOrgMember(tx, auth.userId))) {
        throw createError({ statusCode: 403, statusMessage: 'You don\'t have access to this video' })
      }
      if (video.visibility === 'team') {
        const scope = await getMemberTeamScope(event, tx, auth.userId, orgId, 'videos')
        if (!(await canSeeContainer(tx, scope, 'videos', video.id))) {
          throw createError({ statusCode: 404, statusMessage: 'Video not found' })
        }
      }
      return { video, isOwner }
    }
  )
}
