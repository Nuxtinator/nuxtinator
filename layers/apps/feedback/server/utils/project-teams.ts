// Team restriction for feedback projects, on top of core's team-access helper.
// Member-facing routes and MCP tools resolve a scope once per request, then
// check the project (or a card's project) before touching it.

import type { H3Event } from 'h3'
import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { Permission } from '#core/app/utils/permissions'
import {
  assertTeamAccess,
  canSeeContainer,
  getContainerTeams,
  getTeamScope,
  type ContainerTeam,
  type TeamScope
} from '#core/server/utils/team-access'

type Tx = Transaction<Database>

export function getFeedbackTeamScope(
  event: H3Event,
  tx: Tx,
  ctx: { userId: string, orgId: string | null, perms: Set<Permission> }
): Promise<TeamScope> {
  return getTeamScope(event, tx, ctx, 'feedback')
}

export async function assertFeedbackProjectAccess(tx: Tx, scope: TeamScope, projectId: string): Promise<void> {
  await assertTeamAccess(tx, scope, 'projects', projectId, 'Project not found')
}

// 404 unless the card exists and the caller may see its project. Returns the
// card's project id.
export async function assertFeedbackCardAccess(tx: Tx, scope: TeamScope, cardId: string): Promise<string> {
  const card = await tx
    .selectFrom('cards')
    .select('project_id')
    .where('id', '=', cardId)
    .executeTakeFirst()
  if (!card || !(await canSeeContainer(tx, scope, 'projects', card.project_id))) {
    throw createError({ statusCode: 404, statusMessage: 'Card not found' })
  }
  return card.project_id
}

// 400 unless `swimlaneId` is one of the project's swimlanes.
export async function assertSwimlaneInProject(tx: Tx, projectId: string, swimlaneId: string): Promise<void> {
  const lane = await tx
    .selectFrom('swimlanes')
    .select('id')
    .where('id', '=', swimlaneId)
    .where('project_id', '=', projectId)
    .executeTakeFirst()
  if (!lane) throw createError({ statusCode: 400, statusMessage: 'That swimlane is not in this project' })
}

// Adds each project's teams (`[]` for org-wide projects) for display.
export async function withFeedbackProjectTeams<T extends { id: string }>(
  tx: Tx,
  rows: T[]
): Promise<Array<T & { teams: ContainerTeam[] }>> {
  const teams = await getContainerTeams(tx, 'projects', rows.map(r => r.id))
  return rows.map(r => ({ ...r, teams: teams.get(r.id) ?? [] }))
}
