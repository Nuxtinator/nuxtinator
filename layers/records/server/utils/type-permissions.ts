// The per-type permission evaluator — the single answer to "may this caller
// perform <action> on <typeKey> records?". Implements override-with-fallback
// over the per-type role grants stored on records_types (config.roleGrants)
// with the permission slugs as the default policy. Decision order:
//
//   1. `admin` in ctx.roles → true (mirrors core rbac's admin special case,
//      which unions every registered permission).
//   2. Direct user grants (user_permission_grants) containing
//      permFor(typeKey, action) → true. Personal grants are slug-level,
//      additive, and pass through untouched — a role-keyed per-type row can
//      never subtract them.
//   3. OR over ctx.roles: a present roleGrants[role][action] entry IS that
//      role's answer (true or false); an absent entry falls back to whether
//      the role's OWN slug set contains permFor(typeKey, action). The
//      per-role set comes from core's getRolePermissions for that single
//      role — ctx.perms is the pre-unioned effective set and cannot answer
//      per-role questions.
//   4. Team grants (config.teamGrants): an allowed action for any team the
//      caller is in → true. Teams only add; they never deny.
//
// All lookups (direct grants, per-role slug sets, merged type definitions)
// are memoized per TenantContext — one object per request/transaction, so
// the memo is per-event by construction and never crosses org or request
// boundaries (see dev.md gotcha 5).

import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { Permission } from '#core/app/utils/permissions'
import type { TenantContext } from '#tenant/server'
import { getRolePermissions } from '#core/server/utils/rbac'
import { getUserGrantedPermissions } from '#core/server/utils/permission-grants'
import { getUserGroups } from '#core/server/utils/groups'
import { getRecordTypes, type RecordTypeSetting } from './definition-settings'
import { RECORD_ACTIONS, permFor, type RecordAction, type RecordsTypeRoleGrants, type RecordsTypeTeamGrants } from './records-perms'
import { hasEditShare } from './shares'
import { getRecordsVisibilitySources } from './records-registry'

type Tx = Transaction<Database>

export type RecordsTypeCapabilities = Record<RecordAction, boolean>

interface EvalMemo {
  directGrants?: Promise<Set<Permission>>
  roleSlugs: Map<string, Promise<Set<Permission>>>
  types?: Promise<RecordTypeSetting[]>
  teamIds?: Promise<Set<string>>
}

const memos = new WeakMap<TenantContext, EvalMemo>()

function memoFor(ctx: TenantContext): EvalMemo {
  let memo = memos.get(ctx)
  if (!memo) {
    memo = { roleSlugs: new Map() }
    memos.set(ctx, memo)
  }
  return memo
}

function directGrants(tx: Tx, ctx: TenantContext): Promise<Set<Permission>> {
  const memo = memoFor(ctx)
  if (!memo.directGrants) {
    memo.directGrants = getUserGrantedPermissions(tx, ctx.userId)
  }
  return memo.directGrants
}

// One role's own slug set. Resolved role-by-role because the fallback needs
// per-role answers; results are shared across every type/action evaluated in
// the same request.
function roleSlugSet(tx: Tx, ctx: TenantContext, role: string): Promise<Set<Permission>> {
  const memo = memoFor(ctx)
  let hit = memo.roleSlugs.get(role)
  if (!hit) {
    hit = getRolePermissions(tx, [role], ctx.orgId)
    memo.roleSlugs.set(role, hit)
  }
  return hit
}

// The caller's teams in the current org (host groups in single mode).
function teamIds(tx: Tx, ctx: TenantContext): Promise<Set<string>> {
  const memo = memoFor(ctx)
  if (!memo.teamIds) {
    memo.teamIds = getUserGroups(tx, ctx.userId, ctx.orgId).then(groups => new Set(groups.map(g => g.id)))
  }
  return memo.teamIds
}

// The type's role and team grants from the merged definitions — one
// definitions read per request regardless of how many types get evaluated.
async function typeGrants(tx: Tx, ctx: TenantContext, typeKey: string): Promise<{ roles: RecordsTypeRoleGrants, teams: RecordsTypeTeamGrants }> {
  const memo = memoFor(ctx)
  if (!memo.types) {
    memo.types = getRecordTypes(tx)
  }
  const type = (await memo.types).find(t => t.key === typeKey)
  return { roles: type?.roleGrants ?? {}, teams: type?.teamGrants ?? {} }
}

async function resolveAgainst(
  tx: Tx,
  ctx: TenantContext,
  typeKey: string,
  action: RecordAction,
  grants: Set<Permission>,
  typeGrants: { roles: RecordsTypeRoleGrants, teams: RecordsTypeTeamGrants }
): Promise<boolean> {
  const slug = permFor(typeKey, action)
  if (grants.has(slug)) return true
  for (const role of ctx.roles) {
    const row = typeGrants.roles[role]?.[action]
    if (row === true) return true
    if (row === false) continue
    if ((await roleSlugSet(tx, ctx, role)).has(slug)) return true
  }
  const granting = Object.entries(typeGrants.teams).filter(([, actions]) => actions[action] === true)
  if (granting.length > 0) {
    const mine = await teamIds(tx, ctx)
    if (granting.some(([groupId]) => mine.has(groupId))) return true
  }
  return false
}

export async function resolveTypePermission(
  tx: Tx,
  ctx: TenantContext,
  typeKey: string,
  action: RecordAction
): Promise<boolean> {
  if (ctx.roles.includes('admin')) return true
  const grants = await directGrants(tx, ctx)
  return await resolveAgainst(tx, ctx, typeKey, action, grants, await typeGrants(tx, ctx, typeKey))
}

// All six actions in one pass, sharing the grant and per-role slug lookups.
export async function resolveTypeCapabilities(
  tx: Tx,
  ctx: TenantContext,
  typeKey: string
): Promise<RecordsTypeCapabilities> {
  const caps = {} as RecordsTypeCapabilities
  if (ctx.roles.includes('admin')) {
    for (const action of RECORD_ACTIONS) caps[action] = true
    return caps
  }
  const grants = await directGrants(tx, ctx)
  const forType = await typeGrants(tx, ctx, typeKey)
  for (const action of RECORD_ACTIONS) {
    caps[action] = await resolveAgainst(tx, ctx, typeKey, action, grants, forType)
  }
  return caps
}

// Route gate: 403 with the slug name when the evaluator denies.
export async function requireTypePermission(
  tx: Tx,
  ctx: TenantContext,
  typeKey: string,
  action: RecordAction
): Promise<void> {
  if (!(await resolveTypePermission(tx, ctx, typeKey, action))) {
    throw createError({ statusCode: 403, statusMessage: `Permission required: ${permFor(typeKey, action)}` })
  }
}

// The record-scoped update capability: the type-level update answer OR an
// edit-level share on this specific record OR a visibility source that lets
// the caller edit it (a hand-picked view at 'edit'), on types whose boards
// grant visibility. Delete has no share-level equivalent — it stays
// type-level only.
export async function canUpdateRecord(
  tx: Tx,
  ctx: TenantContext,
  typeKey: string,
  recordId: string
): Promise<boolean> {
  if (await resolveTypePermission(tx, ctx, typeKey, 'update')) return true
  if (await hasEditShare(tx, recordId, ctx.userId)) return true
  const sources = getRecordsVisibilitySources().filter(s => s.editPredicate)
  if (sources.length === 0) return false
  const types = await (memoFor(ctx).types ??= getRecordTypes(tx))
  if (types.find(t => t.key === typeKey)?.boardsGrantVisibility === false) return false
  const row = await tx
    .selectFrom('records_entries')
    .select('id')
    .where('id', '=', recordId)
    .where('record_type', '=', typeKey)
    .where(eb => eb.or(sources.map(s => s.editPredicate!(eb, { userId: ctx.userId, typeKey }))))
    .executeTakeFirst()
  return !!row
}

export async function requireRecordUpdate(
  tx: Tx,
  ctx: TenantContext,
  typeKey: string,
  recordId: string
): Promise<void> {
  if (!(await canUpdateRecord(tx, ctx, typeKey, recordId))) {
    throw createError({ statusCode: 403, statusMessage: `Permission required: ${permFor(typeKey, 'update')}` })
  }
}
