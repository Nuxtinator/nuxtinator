// Team restriction inside an org. An org app registers each table whose rows
// can be limited to teams (a "container": a Feedback project, a Context
// portfolio), and its member-facing routes ask this module whether the caller
// may see one. It is the only place that decides it, so every app answers the
// same way.
//
// The check is app code, not RLS: RLS still shows the whole org to an org
// transaction. Paths with no user (the feedback widget, public bots, jobs
// looping over orgs) don't call it and keep reaching every container.
//
// A container's visibility column holds the org-wide value (`org`), the team
// value (`teams`), or a value this module doesn't own, which passes straight
// through to RLS. Teams come from a `(container_id, group_id)` table or, for
// one team per row, a `team_id` column.
//
// The caller's teams are their groups in the current org (host groups in
// single mode), and only while that scope's group mode is `teams`. Holders of
// the app's `all_teams` permission can turn on "show all teams", which the
// client asks for with the `all-teams-<appId>` cookie or the
// `X-Show-All-Teams: 1` header.

import type { H3Event } from 'h3'
import { sql, type Expression, type SqlBool, type Transaction } from 'kysely'
import * as tenantKernel from '#tenant/server'
import type { Database } from '#core/server/database/schema'
import type { Permission } from '#core/app/utils/permissions'
import type { DbClient } from './settings'
import { getGroupMode, getUserGroups, registerGroupUsage, type GroupMode } from './groups'

export interface TeamContainer {
  appId: string
  table: string
  // Display title for usage listings (deleting a group in use, switching to audiences).
  titleColumn?: string
  idColumn?: string
  visibilityColumn: string
  orgValue?: string
  teamValue?: string
  // `(container_id, group_id)` rows, for several teams per container.
  teamsTable?: string
  // A single team per row, instead of `teamsTable`.
  teamColumn?: string
  // The row's owner, who always sees it.
  ownerColumn?: string
  allTeamsPermission: string
}

type Container = TeamContainer & Required<Pick<TeamContainer, 'titleColumn' | 'idColumn' | 'orgValue' | 'teamValue'>>

const _containers = new Map<string, Container>()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function registerTeamContainer(input: TeamContainer): void {
  if (!input.teamsTable === !input.teamColumn) {
    throw new Error(`registerTeamContainer(${input.table}): give exactly one of teamsTable or teamColumn`)
  }
  const c: Container = {
    titleColumn: 'name',
    idColumn: 'id',
    orgValue: 'org',
    teamValue: 'teams',
    ...input
  }
  _containers.set(c.table, c)
  registerGroupUsage(c.appId, (tx, groupIds) => usageForApp(tx, c.appId, groupIds))
}

// Read off the kernel namespace so a host still running a tenancy layer that
// predates it fails here, at the call, rather than at build time.
function memberPermissions(tx: Transaction<Database>, userId: string): Promise<Set<Permission>> {
  const fn = (tenantKernel as { getMemberPermissions?: (tx: Transaction<Database>, userId: string) => Promise<Set<Permission>> }).getMemberPermissions
  if (!fn) throw new Error('The loaded #tenant/server kernel has no getMemberPermissions; update the tenancy layer.')
  return fn(tx, userId)
}

export function getTeamContainers(): TeamContainer[] {
  return [..._containers.values()]
}

function container(table: string): Container {
  const c = _containers.get(table)
  if (!c) throw new Error(`No team container registered for table "${table}"`)
  return c
}

async function usageForApp(tx: DbClient, appId: string, groupIds: string[]) {
  const out: Array<{ id: string, title: string, groupId: string }> = []
  for (const c of _containers.values()) {
    if (c.appId !== appId) continue
    const rows = c.teamsTable
      ? await sql<{ id: string, title: string, group_id: string }>`
          select t.${sql.ref(c.idColumn)}::text as id, t.${sql.ref(c.titleColumn)}::text as title, tt.group_id::text as group_id
          from ${sql.table(c.teamsTable)} tt
          join ${sql.table(c.table)} t on t.${sql.ref(c.idColumn)} = tt.container_id
          where tt.group_id in (${sql.join(groupIds)})
        `.execute(tx)
      : await sql<{ id: string, title: string, group_id: string }>`
          select t.${sql.ref(c.idColumn)}::text as id, t.${sql.ref(c.titleColumn)}::text as title, t.${sql.ref(c.teamColumn!)}::text as group_id
          from ${sql.table(c.table)} t
          where t.${sql.ref(c.teamColumn!)} in (${sql.join(groupIds)})
        `.execute(tx)
    for (const r of rows.rows) out.push({ id: r.id, title: r.title, groupId: r.group_id })
  }
  return out
}

export interface TeamScope {
  appId: string
  userId: string
  orgId: string | null
  mode: GroupMode
  // The caller's teams in this org; empty in an audiences-mode org.
  teamIds: string[]
  // The caller holds the app's `all_teams` permission.
  canShowAll: boolean
  // "Show all teams" is on for this request (only ever with `canShowAll`).
  allTeams: boolean
}

interface ScopeContext {
  userId: string
  orgId: string | null
  perms: Set<Permission>
}

export function allTeamsCookieName(appId: string): string {
  return `${useRuntimeConfig().public.cookiePrefix || ''}all-teams-${appId}`
}

function showAllRequested(event: H3Event, appId: string): boolean {
  return getRequestHeader(event, 'x-show-all-teams') === '1' || getCookie(event, allTeamsCookieName(appId)) === '1'
}

// Once per request: the caller's teams in the current org, and whether
// "show all teams" is on.
export async function getTeamScope(event: H3Event, tx: DbClient, ctx: ScopeContext, appId: string): Promise<TeamScope> {
  const perm = [..._containers.values()].find(c => c.appId === appId)?.allTeamsPermission
  const mode = await getGroupMode(tx, ctx.orgId)
  const teamIds = mode === 'teams' ? (await getUserGroups(tx, ctx.userId, ctx.orgId)).map(g => g.id) : []
  const canShowAll = !!perm && ctx.perms.has(perm as Permission)
  return {
    appId,
    userId: ctx.userId,
    orgId: ctx.orgId,
    mode,
    teamIds,
    canShowAll,
    allTeams: canShowAll && showAllRequested(event, appId)
  }
}

// A `where` expression for list queries, search and pickers over `table`
// (or its `alias` in the query). A row passes when its visibility isn't the
// team value, when one of its teams is the caller's, when the caller owns it,
// or while "show all teams" is on.
export function teamVisible(scope: TeamScope, table: string, alias?: string): Expression<SqlBool> {
  const c = container(table)
  if (scope.allTeams) return sql<SqlBool>`true`
  const col = (name: string) => sql.ref(`${alias ?? c.table}.${name}`)
  const branches = [sql<SqlBool>`${col(c.visibilityColumn)} is distinct from ${c.teamValue}`]
  if (scope.teamIds.length > 0) {
    const ids = sql.join(scope.teamIds.map(id => sql`${id}::uuid`))
    branches.push(c.teamsTable
      ? sql<SqlBool>`exists (select 1 from ${sql.table(c.teamsTable)} tt where tt.container_id = ${col(c.idColumn)} and tt.group_id in (${ids}))`
      : sql<SqlBool>`${col(c.teamColumn!)} in (${ids})`)
  }
  if (c.ownerColumn) branches.push(sql<SqlBool>`${col(c.ownerColumn)} = ${scope.userId}::uuid`)
  return sql<SqlBool>`(${sql.join(branches, sql` or `)})`
}

// For anything loaded by id or slug: 404 unless the caller may see container
// `id`. Child routes pass their container's id. 404, never 403, so a refusal
// doesn't confirm the container exists.
export async function assertTeamAccess(
  tx: DbClient,
  scope: TeamScope,
  table: string,
  id: string,
  notFoundMessage = 'Not found'
): Promise<void> {
  if (!(await canSeeContainer(tx, scope, table, id))) {
    throw createError({ statusCode: 404, statusMessage: notFoundMessage })
  }
}

export async function canSeeContainer(tx: DbClient, scope: TeamScope, table: string, id: string): Promise<boolean> {
  const c = container(table)
  if (!UUID_RE.test(id)) return false
  const row = await sql<{ ok: number }>`
    select 1 as ok from ${sql.table(c.table)}
    where ${sql.ref(`${c.table}.${c.idColumn}`)} = ${id} and ${teamVisible(scope, table)}
  `.execute(tx)
  return row.rows.length > 0
}

export interface ContainerTeam {
  id: string
  name: string
  archived: boolean
}

// The teams each container in `ids` is limited to, for display.
export async function getContainerTeams(tx: DbClient, table: string, ids: string[]): Promise<Map<string, ContainerTeam[]>> {
  const c = container(table)
  const out = new Map<string, ContainerTeam[]>()
  if (ids.length === 0) return out
  const rows = c.teamsTable
    ? await sql<{ container_id: string, id: string, name: string, archived_at: Date | null }>`
        select tt.container_id::text as container_id, g.id::text as id, g.name, g.archived_at
        from ${sql.table(c.teamsTable)} tt join groups g on g.id = tt.group_id
        where tt.container_id in (${sql.join(ids)})
        order by lower(g.name)
      `.execute(tx)
    : await sql<{ container_id: string, id: string, name: string, archived_at: Date | null }>`
        select t.${sql.ref(c.idColumn)}::text as container_id, g.id::text as id, g.name, g.archived_at
        from ${sql.table(c.table)} t join groups g on g.id = t.${sql.ref(c.teamColumn!)}
        where t.${sql.ref(c.idColumn)} in (${sql.join(ids)})
      `.execute(tx)
  for (const r of rows.rows) {
    const list = out.get(r.container_id) ?? []
    list.push({ id: r.id, name: r.name, archived: !!r.archived_at })
    out.set(r.container_id, list)
  }
  return out
}

export interface ContainerTeamsInput {
  visibility: string
  teamIds: string[]
}

// Reads `{ visibility, teamIds }` from a request body for a container with a
// teams table. Returns undefined when the body names neither.
export function readContainerTeamsInput(table: string, body: unknown): ContainerTeamsInput | undefined {
  const c = container(table)
  const b = (body ?? {}) as { visibility?: unknown, teamIds?: unknown }
  if (b.visibility === undefined && b.teamIds === undefined) return undefined
  if (b.visibility !== c.orgValue && b.visibility !== c.teamValue) {
    throw createError({ statusCode: 400, statusMessage: `visibility must be '${c.orgValue}' or '${c.teamValue}'` })
  }
  const teamIds = b.teamIds ?? []
  if (!Array.isArray(teamIds) || !teamIds.every(id => typeof id === 'string' && UUID_RE.test(id))) {
    throw createError({ statusCode: 400, statusMessage: 'teamIds must be a list of team ids' })
  }
  return { visibility: b.visibility, teamIds: [...new Set(teamIds as string[])] }
}

// Saves a container's visibility and teams. Call `assertTeamAccess` first.
// Newly added teams must be live groups of this org that the caller is on
// (or any of the org's teams for holders of `all_teams`). Unless "show all
// teams" is on, a change that would leave the caller unable to see the
// container is refused, so nobody locks themselves out by saving.
export async function setContainerTeams(
  tx: DbClient,
  scope: TeamScope,
  table: string,
  id: string,
  input: ContainerTeamsInput
): Promise<void> {
  const c = container(table)
  if (!c.teamsTable) throw new Error(`setContainerTeams(${table}): container has no teams table`)
  const limited = input.visibility === c.teamValue
  const wanted = limited ? input.teamIds : []

  if (limited) {
    if (scope.mode !== 'teams') {
      throw createError({ statusCode: 400, statusMessage: 'Teams are off here, so content can\'t be limited to them.' })
    }
    if (wanted.length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'Pick at least one team.' })
    }
  }

  const current = (await sql<{ group_id: string }>`
    select group_id::text as group_id from ${sql.table(c.teamsTable)} where container_id = ${id}
  `.execute(tx)).rows.map(r => r.group_id)
  const added = wanted.filter(g => !current.includes(g))
  const removed = current.filter(g => !wanted.includes(g))

  if (added.length > 0) {
    const valid = await tx
      .selectFrom('groups')
      .select('id')
      .where('id', 'in', added)
      .where('archived_at', 'is', null)
      .$if(scope.orgId === null, qb => qb.where('org_id', 'is', null))
      .$if(scope.orgId !== null, qb => qb.where('org_id', '=', scope.orgId!))
      .execute()
    if (valid.length !== added.length) {
      throw createError({ statusCode: 400, statusMessage: 'Unknown or archived team' })
    }
    if (!scope.canShowAll && added.some(g => !scope.teamIds.includes(g))) {
      throw createError({ statusCode: 403, statusMessage: 'You can only pick teams you are on.' })
    }
  }

  // With "show all teams" on the caller keeps access through the toggle.
  if (limited && !scope.allTeams && !wanted.some(g => scope.teamIds.includes(g))) {
    const owned = c.ownerColumn
      ? (await sql<{ ok: number }>`
          select 1 as ok from ${sql.table(c.table)}
          where ${sql.ref(c.idColumn)} = ${id} and ${sql.ref(c.ownerColumn)} = ${scope.userId}::uuid
        `.execute(tx)).rows.length > 0
      : false
    if (!owned) {
      throw createError({ statusCode: 409, statusMessage: 'Include a team you are on, or you would lose access to this.' })
    }
  }

  await sql`
    update ${sql.table(c.table)} set ${sql.ref(c.visibilityColumn)} = ${input.visibility}
    where ${sql.ref(c.idColumn)} = ${id}
  `.execute(tx)
  if (removed.length > 0) {
    await sql`
      delete from ${sql.table(c.teamsTable)} where container_id = ${id} and group_id in (${sql.join(removed)})
    `.execute(tx)
  }
  for (const groupId of added) {
    await sql`insert into ${sql.table(c.teamsTable)} (container_id, group_id) values (${id}, ${groupId})`.execute(tx)
  }
}

// For anything that sends a container's content to people (notifications,
// digests, emails): keeps the users in `userIds` who could see the container
// — its teams' members and holders of the app's `all_teams` permission. Needs
// no caller, so paths without a user can use it; run it inside the
// container's org transaction.
export async function filterRecipients(
  tx: Transaction<Database>,
  table: string,
  id: string,
  userIds: string[]
): Promise<string[]> {
  const c = container(table)
  if (userIds.length === 0) return []
  const row = (await sql<{ visibility: string | null, owner: string | null }>`
    select ${sql.ref(c.visibilityColumn)}::text as visibility,
      ${c.ownerColumn ? sql`${sql.ref(c.ownerColumn)}::text` : sql`null`} as owner
    from ${sql.table(c.table)} where ${sql.ref(c.idColumn)} = ${id}
  `.execute(tx)).rows[0]
  if (!row) return []
  if (row.visibility !== c.teamValue) return userIds

  const teamIds = (await getContainerTeams(tx, table, [id])).get(id)?.map(t => t.id) ?? []
  const onTeam = teamIds.length === 0
    ? new Set<string>()
    : new Set((await tx
        .selectFrom('group_members')
        .select('user_id')
        .where('group_id', 'in', teamIds)
        .where('user_id', 'in', userIds)
        .execute()).map(r => r.user_id))

  const out: string[] = []
  for (const userId of userIds) {
    if (onTeam.has(userId) || row.owner === userId) {
      out.push(userId)
      continue
    }
    const perms = await memberPermissions(tx, userId)
    if (perms.has(c.allTeamsPermission as Permission)) out.push(userId)
  }
  return out
}
