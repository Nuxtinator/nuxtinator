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
import { getRecordTypes, type RecordTypeSetting } from './definition-settings'
import { RECORD_ACTIONS, permFor, type RecordAction, type RecordsTypeRoleGrants } from './records-perms'
import { hasEditShare } from './shares'

type Tx = Transaction<Database>

export type RecordsTypeCapabilities = Record<RecordAction, boolean>

interface EvalMemo {
  directGrants?: Promise<Set<Permission>>
  roleSlugs: Map<string, Promise<Set<Permission>>>
  types?: Promise<RecordTypeSetting[]>
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

// The type's roleGrants map from the merged definitions — one definitions
// read per request regardless of how many types get evaluated.
async function typeRoleGrants(tx: Tx, ctx: TenantContext, typeKey: string): Promise<RecordsTypeRoleGrants> {
  const memo = memoFor(ctx)
  if (!memo.types) {
    memo.types = getRecordTypes(tx)
  }
  const types = await memo.types
  return types.find(t => t.key === typeKey)?.roleGrants ?? {}
}

async function resolveAgainst(
  tx: Tx,
  ctx: TenantContext,
  typeKey: string,
  action: RecordAction,
  grants: Set<Permission>,
  roleGrants: RecordsTypeRoleGrants
): Promise<boolean> {
  const slug = permFor(typeKey, action)
  if (grants.has(slug)) return true
  for (const role of ctx.roles) {
    const row = roleGrants[role]?.[action]
    if (row === true) return true
    if (row === false) continue
    if ((await roleSlugSet(tx, ctx, role)).has(slug)) return true
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
  const roleGrants = await typeRoleGrants(tx, ctx, typeKey)
  return await resolveAgainst(tx, ctx, typeKey, action, grants, roleGrants)
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
  const roleGrants = await typeRoleGrants(tx, ctx, typeKey)
  for (const action of RECORD_ACTIONS) {
    caps[action] = await resolveAgainst(tx, ctx, typeKey, action, grants, roleGrants)
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
// edit-level share on this specific record. Delete has no share-level
// equivalent — it stays type-level only.
export async function canUpdateRecord(
  tx: Tx,
  ctx: TenantContext,
  typeKey: string,
  recordId: string
): Promise<boolean> {
  if (await resolveTypePermission(tx, ctx, typeKey, 'update')) return true
  return await hasEditShare(tx, recordId, ctx.userId)
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
