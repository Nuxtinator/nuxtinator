// An org's groups, managed by holders of `org.groups.manage` from the org's
// settings and by host admins from /admin/orgs. Both route sets run these in a
// transaction scoped to the org (its GUC set), so the org's group mode and
// what limits content to its groups read that org's rows.

import type { H3Event } from 'h3'
import { getRouterParam } from 'h3'
import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import { logEvent } from '#core/server/utils/activity-logger'
import {
  addGroupMember,
  createGroup,
  deleteGroup,
  getAppGroups,
  getGroup,
  getGroupMode,
  listGroupMembers,
  listGroups,
  parseGroupMode,
  removeGroupMember,
  renameGroup,
  setAppGroups,
  setGroupArchived,
  setGroupMode
} from '#core/server/utils/groups'
import { getApp } from '#core/server/utils/app-settings'
import { adminDb } from './database-admin'
import { withOrgScope } from './tenant'

type Tx = Transaction<Database>

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Runs `fn` for a host admin in the org a `/api/admin/orgs/:orgId/…` route
// names: 404 for an unknown org, then a transaction scoped to it.
export async function asHostAdminInOrg<T>(event: H3Event, fn: (tx: Tx, orgId: string) => Promise<T>): Promise<T> {
  const orgId = getRouterParam(event, 'orgId')
  const org = orgId && UUID_RE.test(orgId)
    ? await adminDb.selectFrom('orgs').select('id').where('id', '=', orgId).executeTakeFirst()
    : undefined
  if (!org) throw createError({ statusCode: 404, statusMessage: 'Organization not found' })
  return await withOrgScope(org.id, tx => fn(tx, org.id))
}

// The org group a route names, or 404. Host groups and other orgs' groups
// are not reachable through an org's routes.
export async function requireOrgGroup(tx: Tx, orgId: string, id: string | undefined) {
  const group = id && UUID_RE.test(id) ? await getGroup(tx, id) : null
  if (!group || group.org_id !== orgId) throw createError({ statusCode: 404, statusMessage: 'Group not found' })
  return group
}

export async function listOrgGroups(tx: Tx, orgId: string) {
  const [mode, groups] = await Promise.all([getGroupMode(tx, orgId), listGroups(tx, orgId)])
  return { mode, groups }
}

export async function createOrgGroup(event: H3Event, tx: Tx, orgId: string, actorId: string) {
  const body = await readBody(event)
  const group = await createGroup(tx, { orgId, name: body?.name })
  logEvent({ eventType: 'org_group_created', tableName: 'groups', recordId: group.id, userId: actorId, metadata: { orgId, name: body?.name } }, tx).catch(() => {})
  return group
}

export async function updateOrgGroup(event: H3Event, tx: Tx, orgId: string, actorId: string) {
  const group = await requireOrgGroup(tx, orgId, getRouterParam(event, 'id'))
  const body = await readBody(event)
  if (body?.name !== undefined) await renameGroup(tx, group.id, body.name)
  if (typeof body?.archived === 'boolean') await setGroupArchived(tx, group.id, body.archived)
  logEvent({ eventType: 'org_group_updated', tableName: 'groups', recordId: group.id, userId: actorId, metadata: { orgId, name: body?.name, archived: body?.archived } }, tx).catch(() => {})
  return { id: group.id }
}

export async function deleteOrgGroup(event: H3Event, tx: Tx, orgId: string, actorId: string) {
  const group = await requireOrgGroup(tx, orgId, getRouterParam(event, 'id'))
  await deleteGroup(tx, group.id)
  logEvent({ eventType: 'org_group_deleted', tableName: 'groups', recordId: group.id, userId: actorId, metadata: { orgId, name: group.name } }, tx).catch(() => {})
  return { success: true }
}

export async function setOrgGroupMode(event: H3Event, tx: Tx, orgId: string, actorId: string) {
  const body = await readBody(event)
  if (body?.mode !== 'audiences' && body?.mode !== 'teams') {
    throw createError({ statusCode: 400, statusMessage: 'mode must be \'audiences\' or \'teams\'' })
  }
  const mode = parseGroupMode(body.mode)
  await setGroupMode(tx, orgId, mode)
  logEvent({ eventType: 'org_group_mode_changed', tableName: 'core_settings', userId: actorId, metadata: { orgId, mode } }, tx).catch(() => {})
  return { mode }
}

export async function listOrgGroupMembers(event: H3Event, tx: Tx, orgId: string) {
  const group = await requireOrgGroup(tx, orgId, getRouterParam(event, 'id'))
  return { members: await listGroupMembers(tx, group.id) }
}

// Org members whose name or email matches `q` (all of them when it's empty, up
// to 50), for the group member picker.
export async function searchOrgGroupCandidates(tx: Tx, orgId: string, q: unknown) {
  const term = typeof q === 'string' ? q.trim() : ''
  const pattern = term ? `%${term.replace(/[\\%_]/g, c => `\\${c}`)}%` : null
  const users = await tx
    .selectFrom('memberships')
    .innerJoin('users', 'users.id', 'memberships.user_id')
    .select(['users.id', 'users.display_name', 'users.email', 'users.avatar'])
    .where('memberships.org_id', '=', orgId)
    .$if(!!pattern, qb => qb.where(eb => eb.or([
      eb('users.display_name', 'ilike', pattern!),
      eb('users.email', 'ilike', pattern!)
    ])))
    .orderBy('users.display_name')
    .limit(50)
    .execute()
  return { users }
}

// Only members of the org can join its groups.
export async function addOrgGroupMember(event: H3Event, tx: Tx, orgId: string, actorId: string) {
  const group = await requireOrgGroup(tx, orgId, getRouterParam(event, 'id'))
  const userId = getRouterParam(event, 'userId')
  const member = userId && UUID_RE.test(userId)
    ? await tx.selectFrom('memberships').select('user_id').where('org_id', '=', orgId).where('user_id', '=', userId).executeTakeFirst()
    : undefined
  if (!member) throw createError({ statusCode: 404, statusMessage: 'Member not found' })
  await addGroupMember(tx, { groupId: group.id, userId: member.user_id, addedBy: actorId })
  logEvent({ eventType: 'org_group_member_added', tableName: 'group_members', recordId: group.id, userId: actorId, metadata: { orgId, memberId: member.user_id } }, tx).catch(() => {})
  return { groupId: group.id, userId: member.user_id }
}

export async function removeOrgGroupMember(event: H3Event, tx: Tx, orgId: string, actorId: string) {
  const group = await requireOrgGroup(tx, orgId, getRouterParam(event, 'id'))
  const userId = getRouterParam(event, 'userId')
  if (!userId || !UUID_RE.test(userId)) throw createError({ statusCode: 404, statusMessage: 'Member not found' })
  await removeGroupMember(tx, group.id, userId)
  logEvent({ eventType: 'org_group_member_removed', tableName: 'group_members', recordId: group.id, userId: actorId, metadata: { orgId, memberId: userId } }, tx).catch(() => {})
  return { groupId: group.id, userId }
}

// An org app the route names, or 404. Personal apps take host groups only.
async function requireOrgApp(tx: Tx, appId: string | undefined) {
  const app = appId ? await getApp(tx, appId) : undefined
  if (!app?.installed || app.scope === 'user') throw createError({ statusCode: 404, statusMessage: 'App not found' })
  return app
}

// The org's groups, with whether each can open the app (the team gate).
// Archived groups are listed only while they're still on the app's list.
export async function listOrgAppGroups(event: H3Event, tx: Tx, orgId: string) {
  const app = await requireOrgApp(tx, getRouterParam(event, 'appId'))
  const [groups, selected] = await Promise.all([listGroups(tx, orgId), getAppGroups(tx, app.id)])
  const selectedIds = new Set(selected.filter(g => g.org_id === orgId).map(g => g.id))
  return {
    groups: groups
      .filter(g => !g.archived_at || selectedIds.has(g.id))
      .map(g => ({ id: g.id, name: g.name, member_count: g.member_count, archived: !!g.archived_at, selected: selectedIds.has(g.id) }))
  }
}

export async function setOrgAppGroups(event: H3Event, tx: Tx, orgId: string, actorId: string) {
  const app = await requireOrgApp(tx, getRouterParam(event, 'appId'))
  const body = await readBody(event)
  const groupIds = body?.groupIds
  if (!Array.isArray(groupIds) || !groupIds.every(id => typeof id === 'string' && UUID_RE.test(id))) {
    throw createError({ statusCode: 400, statusMessage: 'groupIds must be a list of group ids' })
  }
  await setAppGroups(tx, { appId: app.id, orgId, groupIds, grantedBy: actorId })
  logEvent({ eventType: 'org_app_groups_changed', tableName: 'app_groups', recordId: app.id, userId: actorId, metadata: { orgId, groupIds } }, tx).catch(() => {})
  return { id: app.id, groupIds }
}
