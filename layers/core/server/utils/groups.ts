// Groups: named sets of users. A host group (`org_id` NULL) is managed by host
// admins and can gate personal apps; an org's groups belong to that org and
// can gate its org apps. In single mode host groups also gate org apps. In
// teams mode a group can also limit content (see team-access.ts).
//
// What a group means comes from the group mode, never from the row:
//   'audiences' (default) — groups only gate apps; members don't see the group
//                           or each other.
//   'teams'               — members see the group and its members.
// The host's own groups take the instance-wide mode (a host setting); an
// org's groups take the org's mode (an org setting).
//
// None of the group tables has RLS. Who may see a group or its members is
// decided here and in the handlers, the same way the users table is.

import { sql } from 'kysely'
import type { DbClient } from './settings'
import { clearHostSetting, clearSetting, getHostSetting, getSetting, setHostSetting, setSetting } from './settings-store'

export type GroupMode = 'audiences' | 'teams'

export const GROUPS_SETTINGS_NAMESPACE = 'core'
export const SETTING_GROUP_MODE = 'group_mode'

export function parseGroupMode(value: unknown): GroupMode {
  return value === 'teams' ? 'teams' : 'audiences'
}

// The mode of the host's own groups.
export async function getHostGroupMode(tx: DbClient): Promise<GroupMode> {
  return await getHostSetting<GroupMode>(tx, GROUPS_SETTINGS_NAMESPACE, SETTING_GROUP_MODE)
}

// The mode of one scope's groups: the host's (`orgId` null) or an org's. An
// org's mode is an org setting, so `tx` must run in that org (its GUC set).
export async function getGroupMode(tx: DbClient, orgId: string | null): Promise<GroupMode> {
  if (orgId === null) return await getHostGroupMode(tx)
  return parseGroupMode(await getSetting(tx, GROUPS_SETTINGS_NAMESPACE, SETTING_GROUP_MODE))
}

// Changes the mode of the host's own groups. See `setGroupMode`.
export async function setHostGroupMode(tx: DbClient, mode: GroupMode): Promise<void> {
  await setGroupMode(tx, null, mode)
}

// Changes the mode of one scope's groups. Switching to audiences is refused
// (409) while content is limited to any of the scope's groups, since audience
// groups can't be picked to limit content. Audiences is the default, so
// choosing it drops the override. For an org, `tx` must run in that org.
export async function setGroupMode(tx: DbClient, orgId: string | null, mode: GroupMode): Promise<void> {
  const current = await getGroupMode(tx, orgId)
  if (current === mode) return
  if (mode === 'audiences') {
    const scopeGroups = await tx
      .selectFrom('groups')
      .select('id')
      .$if(orgId === null, qb => qb.where('org_id', 'is', null))
      .$if(orgId !== null, qb => qb.where('org_id', '=', orgId!))
      .execute()
    const usage = await getGroupUsage(tx, scopeGroups.map(g => g.id))
    if (usage.length > 0) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Content is still limited to groups. Move it off them before switching to audiences.',
        data: { usage }
      })
    }
    if (orgId === null) await clearHostSetting(tx, GROUPS_SETTINGS_NAMESPACE, SETTING_GROUP_MODE)
    else await clearSetting(tx, GROUPS_SETTINGS_NAMESPACE, SETTING_GROUP_MODE)
  } else if (orgId === null) {
    await setHostSetting(tx, GROUPS_SETTINGS_NAMESPACE, SETTING_GROUP_MODE, mode)
  } else {
    await setSetting(tx, GROUPS_SETTINGS_NAMESPACE, SETTING_GROUP_MODE, mode)
  }
}

// Content an app limits to a group. Layers register a lister so a group in use
// can't be deleted, and teams mode can't be switched off, from under it.
export interface GroupUsageItem {
  id: string
  title: string
}

export interface GroupUsage {
  appId: string
  items: GroupUsageItem[]
}

type GroupUsageLister = (tx: DbClient, groupIds: string[]) => Promise<Array<GroupUsageItem & { groupId: string }>>

const _usageListers = new Map<string, GroupUsageLister>()

export function registerGroupUsage(appId: string, lister: GroupUsageLister): void {
  if (typeof appId !== 'string' || appId.length === 0) return
  _usageListers.set(appId, lister)
}

// What still uses any of `groupIds`, per app. Empty when nothing does.
export async function getGroupUsage(tx: DbClient, groupIds: string[]): Promise<GroupUsage[]> {
  if (groupIds.length === 0) return []
  const out: GroupUsage[] = []
  for (const [appId, lister] of _usageListers) {
    const items = await lister(tx, groupIds)
    if (items.length > 0) out.push({ appId, items: items.map(({ id, title }) => ({ id, title })) })
  }
  return out
}

export interface GroupRow {
  id: string
  org_id: string | null
  name: string
  archived_at: Date | null
  created_at: Date
  member_count: number
}

// Groups in one scope: the host's (`orgId` null) or an org's.
export async function listGroups(tx: DbClient, orgId: string | null): Promise<GroupRow[]> {
  const rows = await tx
    .selectFrom('groups')
    .select(['groups.id', 'groups.org_id', 'groups.name', 'groups.archived_at', 'groups.created_at'])
    .select(eb => eb.selectFrom('group_members')
      .whereRef('group_members.group_id', '=', 'groups.id')
      .select(eb2 => eb2.fn.countAll<string>().as('n'))
      .as('member_count'))
    .$if(orgId === null, qb => qb.where('groups.org_id', 'is', null))
    .$if(orgId !== null, qb => qb.where('groups.org_id', '=', orgId!))
    .orderBy(sql`archived_at is not null`)
    .orderBy(sql`lower(name)`)
    .execute()
  return rows.map(r => ({ ...r, member_count: Number(r.member_count ?? 0) })) as GroupRow[]
}

export async function getGroup(tx: DbClient, id: string): Promise<Omit<GroupRow, 'member_count'> | null> {
  const row = await tx
    .selectFrom('groups')
    .select(['id', 'org_id', 'name', 'archived_at', 'created_at'])
    .where('id', '=', id)
    .executeTakeFirst()
  return (row as Omit<GroupRow, 'member_count'> | undefined) ?? null
}

function cleanName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim() : ''
  if (n.length < 1 || n.length > 80) {
    throw createError({ statusCode: 400, statusMessage: 'Name must be 1 to 80 characters' })
  }
  return n
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === '23505'
}

export async function createGroup(tx: DbClient, input: { orgId: string | null, name: unknown }): Promise<{ id: string }> {
  const name = cleanName(input.name)
  try {
    return await tx
      .insertInto('groups')
      .values({ org_id: input.orgId, name })
      .returning('id')
      .executeTakeFirstOrThrow()
  } catch (err) {
    if (isUniqueViolation(err)) throw createError({ statusCode: 409, statusMessage: 'A group with that name already exists' })
    throw err
  }
}

export async function renameGroup(tx: DbClient, id: string, name: unknown): Promise<void> {
  const clean = cleanName(name)
  try {
    await tx.updateTable('groups').set({ name: clean }).where('id', '=', id).execute()
  } catch (err) {
    if (isUniqueViolation(err)) throw createError({ statusCode: 409, statusMessage: 'A group with that name already exists' })
    throw err
  }
}

// An archived group keeps its members and whatever already uses it, but can't
// be picked for anything new.
export async function setGroupArchived(tx: DbClient, id: string, archived: boolean): Promise<void> {
  await tx
    .updateTable('groups')
    .set({ archived_at: archived ? new Date() : null })
    .where('id', '=', id)
    .execute()
}

// Refused (409, with what uses it) while content is limited to the group.
// App access lists don't block it: that access just goes with the group.
export async function deleteGroup(tx: DbClient, id: string): Promise<void> {
  const usage = await getGroupUsage(tx, [id])
  if (usage.length > 0) {
    throw createError({
      statusCode: 409,
      statusMessage: 'This group is still in use. Move that content off the group, or archive the group instead.',
      data: { usage }
    })
  }
  await tx.deleteFrom('groups').where('id', '=', id).execute()
}

export interface GroupMemberRow {
  user_id: string
  display_name: string
  email: string | null
  avatar: string | null
}

export async function listGroupMembers(tx: DbClient, groupId: string): Promise<GroupMemberRow[]> {
  return await tx
    .selectFrom('group_members')
    .innerJoin('users', 'users.id', 'group_members.user_id')
    .select(['users.id as user_id', 'users.display_name', 'users.email', 'users.avatar'])
    .where('group_members.group_id', '=', groupId)
    .orderBy(sql`lower(users.display_name)`)
    .execute() as GroupMemberRow[]
}

export async function addGroupMember(tx: DbClient, input: { groupId: string, userId: string, addedBy: string | null }): Promise<void> {
  await tx
    .insertInto('group_members')
    .values({ group_id: input.groupId, user_id: input.userId, added_by: input.addedBy })
    .onConflict(oc => oc.columns(['group_id', 'user_id']).doNothing())
    .execute()
}

export async function removeGroupMember(tx: DbClient, groupId: string, userId: string): Promise<void> {
  await tx
    .deleteFrom('group_members')
    .where('group_id', '=', groupId)
    .where('user_id', '=', userId)
    .execute()
}

// The groups `userId` is in, in one scope. Archived groups count: they keep
// working for whatever already uses them.
export async function getUserGroups(tx: DbClient, userId: string, orgId: string | null): Promise<Array<{ id: string, name: string, archived_at: Date | null }>> {
  return await tx
    .selectFrom('group_members')
    .innerJoin('groups', 'groups.id', 'group_members.group_id')
    .select(['groups.id', 'groups.name', 'groups.archived_at'])
    .where('group_members.user_id', '=', userId)
    .$if(orgId === null, qb => qb.where('groups.org_id', 'is', null))
    .$if(orgId !== null, qb => qb.where('groups.org_id', '=', orgId!))
    .orderBy(sql`lower(groups.name)`)
    .execute() as Array<{ id: string, name: string, archived_at: Date | null }>
}

// The groups that can open `appId`.
export async function getAppGroups(tx: DbClient, appId: string): Promise<Array<{ id: string, name: string, org_id: string | null, archived_at: Date | null }>> {
  return await tx
    .selectFrom('app_groups')
    .innerJoin('groups', 'groups.id', 'app_groups.group_id')
    .select(['groups.id', 'groups.name', 'groups.org_id', 'groups.archived_at'])
    .where('app_groups.app_id', '=', appId)
    .orderBy(sql`lower(groups.name)`)
    .execute() as Array<{ id: string, name: string, org_id: string | null, archived_at: Date | null }>
}

// Replaces the groups that can open `appId` within one scope. Groups newly
// added must be live (not archived) and belong to that scope; groups already
// on the list may stay even if archived since.
export async function setAppGroups(
  tx: DbClient,
  input: { appId: string, orgId: string | null, groupIds: string[], grantedBy: string | null }
): Promise<void> {
  const wanted = [...new Set(input.groupIds)]
  const current = (await getAppGroups(tx, input.appId)).filter(g => g.org_id === input.orgId)
  const currentIds = new Set(current.map(g => g.id))
  const added = wanted.filter(id => !currentIds.has(id))

  if (added.length > 0) {
    const valid = await tx
      .selectFrom('groups')
      .select('id')
      .where('id', 'in', added)
      .where('archived_at', 'is', null)
      .$if(input.orgId === null, qb => qb.where('org_id', 'is', null))
      .$if(input.orgId !== null, qb => qb.where('org_id', '=', input.orgId!))
      .execute()
    if (valid.length !== added.length) {
      throw createError({ statusCode: 400, statusMessage: 'Unknown or archived group' })
    }
    // The catalog row is normally seeded on first request; make sure the FK holds.
    await tx.insertInto('apps').values({ id: input.appId }).onConflict(oc => oc.column('id').doNothing()).execute()
    await tx
      .insertInto('app_groups')
      .values(added.map(groupId => ({ app_id: input.appId, group_id: groupId, granted_by: input.grantedBy })))
      .execute()
  }

  const removed = [...currentIds].filter(id => !wanted.includes(id))
  if (removed.length > 0) {
    await tx
      .deleteFrom('app_groups')
      .where('app_id', '=', input.appId)
      .where('group_id', 'in', removed)
      .execute()
  }
}

export const APP_TEAM_GATE_MESSAGE = 'This app is open only to certain teams, and you are not on one of them.'

// The team gate on org apps. An org app whose access list (`app_groups`) names
// groups of the scope (the org's, or host groups in single mode) opens only for
// members of one of them; an app with none listed is open. Checked on paths
// that have a user, never in session-less job loops.
export async function isAppOpenToUser(
  tx: DbClient,
  input: { appId: string, orgId: string | null, userId: string }
): Promise<boolean> {
  return !(await appsClosedToUser(tx, input.orgId, input.userId, [input.appId])).has(input.appId)
}

// The app ids, among `appIds` (every app when omitted), that list groups of
// the scope and that `userId` is in none of.
export async function appsClosedToUser(
  tx: DbClient,
  orgId: string | null,
  userId: string,
  appIds?: string[]
): Promise<Set<string>> {
  if (appIds && appIds.length === 0) return new Set()
  const rows = await tx
    .selectFrom('app_groups')
    .innerJoin('groups', 'groups.id', 'app_groups.group_id')
    .leftJoin('group_members', join => join
      .onRef('group_members.group_id', '=', 'app_groups.group_id')
      .on('group_members.user_id', '=', userId))
    .select(['app_groups.app_id', 'group_members.user_id'])
    .$if(orgId === null, qb => qb.where('groups.org_id', 'is', null))
    .$if(orgId !== null, qb => qb.where('groups.org_id', '=', orgId!))
    .$if(!!appIds, qb => qb.where('app_groups.app_id', 'in', appIds!))
    .execute()
  const listed = new Set<string>()
  const open = new Set<string>()
  for (const r of rows) {
    listed.add(r.app_id)
    if (r.user_id) open.add(r.app_id)
  }
  return new Set([...listed].filter(id => !open.has(id)))
}
