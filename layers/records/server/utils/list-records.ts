// The records list engine — filter/sort/search compilation over the storage
// classes, plus the record-visibility rule shared by every read path.
//
// Filters and sorts address logical field keys; the compiler routes each to
// its physical home (see `storageOf` in #records): promoted columns become direct
// WHERE clauses, jsonb keys compare through data->>'key' with a kind-aware
// cast (number ::numeric, date/datetime ::timestamptz, boolean ::boolean),
// and the relational storages (entries, user refs, connections) compile to
// EXISTS subqueries; driver-backed storages (channels) compile through their
// registered driver. The intrinsic record columns — name, status,
// updated_at, created_at — are always addressable, even on admin-created
// types that have no code manifest.
//
// Visibility: a caller without <type>.view_all sees only records they created
// (records_entries.created_by), records shared with them (records_shares), or
// records referencing them through a user field (records_user_refs), plus
// whatever registered visibility sources grant (records on boards they can
// open) for types that allow it.
// Routes never inline these clauses — they go through `listRecords` /
// `assertRecordVisible`.

import { sql } from 'kysely'
import type { Expression, ExpressionBuilder, RawBuilder, SqlBool, Transaction } from 'kysely'
import { z } from 'zod'
import type { Database } from '#core/server/database/schema'
import { isAppEnabledForCurrentOrg, type TenantContext } from '#tenant/server'
import { getRecordType, getRecordTypeFields, type RecordsFieldSetting, type RecordTypeSetting } from './definition-settings'
import { resolveTypePermission } from './type-permissions'
import type { RecordRow } from './record-storage'
import {
  getRecordsStorageDriver,
  getRecordsStorageDrivers,
  getRecordsVisibilitySources,
  type RecordsFilterCond
} from './records-registry'

type Tx = Transaction<Database>
type Eb = ExpressionBuilder<Database, 'records_entries'>

export interface RecordsListOpts {
  /**
   * Keyed by field key. A bare value filters by equality (null = "empty");
   * an object supports { in, contains, gte, lte }, ANDed when combined.
   */
  filters?: Record<string, unknown>
  /**
   * Restrict to specific record ids. Visibility and filters still apply —
   * this is "list these records if I may see them", not raw hydration.
   */
  ids?: string[]
  /** Text search over record names and any driver-backed values (addresses). */
  q?: string
  /** Leaves out records whose status is one of these (records with no status stay). */
  excludeStatuses?: string[]
  /** Field key — or created_at / updated_at — to sort by. */
  sort?: string
  dir?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export type RecordListItem = RecordRow & {
  /** User ids referenced through user fields — the assignment summary. */
  assignedTo: string[]
}

export interface RecordsListResult {
  items: RecordListItem[]
  total: number
}

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100

const uuidSchema = z.string().uuid()

// Op-object filter form; a bare scalar is shorthand for equality.
const filterOpSchema = z.object({
  in: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
  contains: z.string().optional(),
  gte: z.union([z.string(), z.number()]).optional(),
  lte: z.union([z.string(), z.number()]).optional()
}).strict()

function badFilter(key: string, message: string): never {
  throw createError({ statusCode: 400, statusMessage: `${key}: ${message}` })
}

type FilterCond = RecordsFilterCond

function parseFilterConds(key: string, raw: unknown): FilterCond[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return [{ op: 'eq', value: raw }]
  }
  const parsed = filterOpSchema.safeParse(raw)
  if (!parsed.success) badFilter(key, 'expected a value or { in, contains, gte, lte }')
  const conds: FilterCond[] = []
  if (parsed.data.in !== undefined) conds.push({ op: 'in', values: parsed.data.in })
  if (parsed.data.contains !== undefined) conds.push({ op: 'contains', value: parsed.data.contains })
  if (parsed.data.gte !== undefined) conds.push({ op: 'gte', value: parsed.data.gte })
  if (parsed.data.lte !== undefined) conds.push({ op: 'lte', value: parsed.data.lte })
  if (conds.length === 0) badFilter(key, 'empty filter')
  return conds
}

// ILIKE's default escape character is backslash.
function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, m => `\\${m}`)}%`
}

// Comparison RHS coerced to the field's kind so the kind-cast LHS meets a
// compatible parameter (and garbage turns into a clean 400, not a SQL error).
function coerceComparable(def: RecordsFieldSetting, raw: unknown): string | number | boolean {
  switch (def.kind) {
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(raw)
      if (typeof raw === 'boolean' || !Number.isFinite(n)) badFilter(def.key, 'expected a number')
      return n
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return raw
      if (raw === 'true') return true
      if (raw === 'false') return false
      badFilter(def.key, 'expected a boolean')
      break
    }
    case 'date':
    case 'datetime': {
      const parsed = z.string().safeParse(raw)
      if (!parsed.success || Number.isNaN(Date.parse(parsed.data))) badFilter(def.key, 'expected a date string')
      return parsed.data
    }
    default:
      return String(raw)
  }
}

// data->>'key' — text form of a jsonb value (missing keys read as NULL).
function jsonbText(key: string): RawBuilder<string | null> {
  return sql`data->>${key}`
}

// The scalar comparison/sort expression for a promoted or jsonb field, cast
// to the value's native type so comparisons and ORDER BY behave numerically /
// chronologically instead of lexically.
function scalarExpr(def: RecordsFieldSetting): RawBuilder<unknown> {
  if (def.storage === 'promoted') {
    return def.column === 'name' ? sql.ref('records_entries.name') : sql.ref('records_entries.status')
  }
  const text = jsonbText(def.key)
  switch (def.kind) {
    case 'number':
      return sql`(${text})::numeric`
    case 'boolean':
      return sql`(${text})::boolean`
    case 'date':
    case 'datetime':
      return sql`(${text})::timestamptz`
    default:
      return text
  }
}

const TEXT_KINDS = new Set(['text', 'textarea', 'key_select'])
const RANGE_KINDS = new Set(['number', 'date', 'datetime'])

function scalarCond(eb: Eb, def: RecordsFieldSetting, cond: FilterCond): Expression<SqlBool> {
  const lhs = scalarExpr(def)
  switch (cond.op) {
    case 'eq':
      if (cond.value === null) return eb(lhs, 'is', null)
      return eb(lhs, '=', coerceComparable(def, cond.value))
    case 'in': {
      if (cond.values.length === 0) return sql<SqlBool>`false`
      return eb(lhs, 'in', cond.values.map(v => coerceComparable(def, v)))
    }
    case 'contains': {
      if (def.storage !== 'promoted' && !TEXT_KINDS.has(def.kind)) {
        badFilter(def.key, `'contains' is not supported for ${def.kind} fields`)
      }
      const textLhs = def.storage === 'promoted' ? lhs : jsonbText(def.key)
      return eb(textLhs, 'ilike', likePattern(cond.value))
    }
    case 'gte':
    case 'lte': {
      if (!RANGE_KINDS.has(def.kind)) {
        badFilter(def.key, `'${cond.op}' is not supported for ${def.kind} fields`)
      }
      return eb(lhs, cond.op === 'gte' ? '>=' : '<=', coerceComparable(def, cond.value))
    }
  }
}

function entriesCond(eb: Eb, def: RecordsFieldSetting, cond: FilterCond): Expression<SqlBool> {
  const base = eb.selectFrom('records_field_entries as fe')
    .select('fe.id')
    .whereRef('fe.record_id', '=', 'records_entries.id')
    .where('fe.field_key', '=', def.key)
  switch (cond.op) {
    case 'eq':
      // null = "the field has no entries at all".
      if (cond.value === null) return eb.not(eb.exists(base))
      return eb.exists(base.where('fe.normalized_value', '=', String(cond.value).trim()))
    case 'in': {
      if (cond.values.length === 0) return sql<SqlBool>`false`
      return eb.exists(base.where('fe.normalized_value', 'in', cond.values.map(v => String(v).trim())))
    }
    case 'contains':
      return eb.exists(base.where('fe.normalized_value', 'ilike', likePattern(cond.value)))
    default:
      badFilter(def.key, `'${cond.op}' is not supported for multi-value fields`)
  }
}

function userRefsCond(eb: Eb, def: RecordsFieldSetting, cond: FilterCond): Expression<SqlBool> {
  const base = eb.selectFrom('records_user_refs as fu')
    .select('fu.user_id')
    .whereRef('fu.record_id', '=', 'records_entries.id')
    .where('fu.field_key', '=', def.key)
  // uuid columns reject malformed parameters with a SQL error, so validate up
  // front and 400 instead.
  const asUserId = (v: unknown): string => {
    const parsed = uuidSchema.safeParse(v)
    if (!parsed.success) badFilter(def.key, 'expected a user id')
    return parsed.data
  }
  switch (cond.op) {
    case 'eq':
      if (cond.value === null) return eb.not(eb.exists(base))
      return eb.exists(base.where('fu.user_id', '=', asUserId(cond.value)))
    case 'in': {
      if (cond.values.length === 0) return sql<SqlBool>`false`
      return eb.exists(base.where('fu.user_id', 'in', cond.values.map(asUserId)))
    }
    default:
      badFilter(def.key, `'${cond.op}' is not supported for user fields`)
  }
}

// Forward edges only: "records whose <field> includes record X".
function connectionsCond(eb: Eb, def: RecordsFieldSetting, cond: FilterCond): Expression<SqlBool> {
  const base = eb.selectFrom('records_connections as fcn')
    .select('fcn.id')
    .whereRef('fcn.from_record_id', '=', 'records_entries.id')
    .where('fcn.field_key', '=', def.key)
  const asRecordId = (v: unknown): string => {
    const parsed = uuidSchema.safeParse(v)
    if (!parsed.success) badFilter(def.key, 'expected a record id')
    return parsed.data
  }
  switch (cond.op) {
    case 'eq':
      if (cond.value === null) return eb.not(eb.exists(base))
      return eb.exists(base.where('fcn.to_record_id', '=', asRecordId(cond.value)))
    case 'in': {
      if (cond.values.length === 0) return sql<SqlBool>`false`
      return eb.exists(base.where('fcn.to_record_id', 'in', cond.values.map(asRecordId)))
    }
    default:
      badFilter(def.key, `'${cond.op}' is not supported for connection fields`)
  }
}

function driverCond(eb: Eb, def: RecordsFieldSetting, cond: FilterCond): Expression<SqlBool> {
  const driver = getRecordsStorageDriver(def.storage)
  if (!driver) badFilter(def.key, `no storage driver for ${def.storage} fields`)
  return driver.filter(eb, def, cond, { likePattern, badFilter })
}

function filterPredicate(eb: Eb, def: RecordsFieldSetting, raw: unknown): Expression<SqlBool> {
  const conds = parseFilterConds(def.key, raw).map((cond) => {
    switch (def.storage) {
      case 'promoted':
      case 'jsonb':
        return scalarCond(eb, def, cond)
      case 'entries':
        return entriesCond(eb, def, cond)
      case 'user_refs':
        return userRefsCond(eb, def, cond)
      case 'connections':
        return connectionsCond(eb, def, cond)
      case 'channels':
        return driverCond(eb, def, cond)
    }
  })
  return conds.length === 1 ? conds[0]! : eb.and(conds)
}

// Free-text search: record name plus whatever driver-backed values each
// registered storage driver searches (raw or normalized addresses), so "555"
// or "jane@" find the contact.
function qPredicate(eb: Eb, q: string): Expression<SqlBool> {
  const pattern = likePattern(q)
  const legs: Expression<SqlBool>[] = [eb('records_entries.name', 'ilike', pattern)]
  for (const driver of getRecordsStorageDrivers()) {
    if (driver.search) legs.push(driver.search(eb, pattern))
  }
  return eb.or(legs)
}

export function visibilityPredicate(
  eb: Eb,
  userId: string,
  type: Pick<RecordTypeSetting, 'key' | 'boardsGrantVisibility'>
): Expression<SqlBool> {
  const sources = type.boardsGrantVisibility
    ? getRecordsVisibilitySources().map(s => s.predicate(eb, { userId, typeKey: type.key }))
    : []
  return eb.or([
    // Creators always see their own records — without this leg, a caller
    // lacking view_all who creates a record of a type with no user-reference
    // field (most custom types) would lose sight of it the moment it saves.
    eb('records_entries.created_by', '=', userId),
    eb.exists(
      eb.selectFrom('records_shares as vs')
        .select('vs.record_id')
        .whereRef('vs.record_id', '=', 'records_entries.id')
        .where('vs.user_id', '=', userId)
    ),
    eb.exists(
      eb.selectFrom('records_user_refs as vu')
        .select('vu.record_id')
        .whereRef('vu.record_id', '=', 'records_entries.id')
        .where('vu.user_id', '=', userId)
    ),
    ...sources
  ])
}

// name/status are physical columns on every record row, so they stay
// filterable and sortable even on admin-created types with no code manifest
// (whose merged field defs may not declare them).
function intrinsicColumnDef(key: 'name' | 'status'): RecordsFieldSetting {
  return {
    key,
    kind: 'text',
    storage: 'promoted',
    column: key,
    label: key,
    required: false,
    hidden: false,
    order: 0,
    custom: false,
    orphan: false
  }
}

function resolveFieldDef(defsByKey: Map<string, RecordsFieldSetting>, key: string): RecordsFieldSetting | null {
  const def = defsByKey.get(key)
  if (def) return def
  if (key === 'name' || key === 'status') return intrinsicColumnDef(key)
  return null
}

export async function listRecords(
  tx: Tx,
  ctx: TenantContext,
  typeKey: string,
  opts: RecordsListOpts = {}
): Promise<RecordsListResult> {
  // Stale orphan rows describe nothing filterable; real fields only.
  const defs = (await getRecordTypeFields(tx, typeKey)).filter(d => !d.orphan)
  const defsByKey = new Map(defs.map(d => [d.key, d]))

  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
  const offset = Math.max(opts.offset ?? 0, 0)
  const dir = opts.dir ?? 'desc'

  const preds: Array<(eb: Eb) => Expression<SqlBool>> = []
  for (const [key, raw] of Object.entries(opts.filters ?? {})) {
    const def = resolveFieldDef(defsByKey, key)
    if (!def) throw createError({ statusCode: 400, statusMessage: `Unknown filter field: ${key}` })
    preds.push(eb => filterPredicate(eb, def, raw))
  }
  if (opts.ids) {
    if (opts.ids.length === 0) return { items: [], total: 0 }
    for (const id of opts.ids) {
      if (!uuidSchema.safeParse(id).success) badFilter('ids', 'expected record uuids')
    }
    const ids = opts.ids
    preds.push(eb => eb('records_entries.id', 'in', ids))
  }
  const q = opts.q?.trim()
  if (q) preds.push(eb => qPredicate(eb, q))
  const excluded = opts.excludeStatuses ?? []
  if (excluded.length > 0) {
    preds.push(eb => eb.or([
      eb('records_entries.status', 'is', null),
      eb('records_entries.status', 'not in', excluded)
    ]))
  }
  if (!(await resolveTypePermission(tx, ctx, typeKey, 'view_all'))) {
    const type = await getRecordType(tx, typeKey)
    const scope = { key: typeKey, boardsGrantVisibility: type?.boardsGrantVisibility ?? true }
    preds.push(eb => visibilityPredicate(eb, ctx.userId, scope))
  }

  let base = tx.selectFrom('records_entries').where('record_type', '=', typeKey)
  for (const pred of preds) base = base.where(pred)

  const countRow = await base
    .select(eb => eb.fn.countAll().as('total'))
    .executeTakeFirst()
  const total = Number(countRow?.total ?? 0)

  const sortKey = opts.sort ?? 'updated_at'
  let query = base.selectAll()
  if (sortKey === 'updated_at' || sortKey === 'created_at') {
    query = query.orderBy(`records_entries.${sortKey}`, dir)
  } else {
    const def = resolveFieldDef(defsByKey, sortKey)
    if (!def || (def.storage !== 'promoted' && def.storage !== 'jsonb')) {
      throw createError({ statusCode: 400, statusMessage: `Cannot sort by field: ${sortKey}` })
    }
    query = query.orderBy(scalarExpr(def), dir)
  }
  const rows = await query
    // Stable pagination regardless of ties in the sort key.
    .orderBy('records_entries.id', 'asc')
    .limit(limit)
    .offset(offset)
    .execute()

  // Summary hydration: one batched read of user references (the assignment
  // summary). Full field hydration is reserved for the detail path.
  const assigned = new Map<string, string[]>()
  const userRefKeys = defs.filter(d => d.storage === 'user_refs').map(d => d.key)
  if (rows.length > 0 && userRefKeys.length > 0) {
    const refs = await tx
      .selectFrom('records_user_refs')
      .select(['record_id', 'user_id'])
      .where('record_id', 'in', rows.map(r => r.id))
      .where('field_key', 'in', userRefKeys)
      .orderBy('created_at', 'asc')
      .execute()
    for (const ref of refs) {
      const list = assigned.get(ref.record_id) ?? []
      if (!list.includes(ref.user_id)) list.push(ref.user_id)
      assigned.set(ref.record_id, list)
    }
  }

  return {
    items: rows.map(row => ({ ...row, assignedTo: assigned.get(row.id) ?? [] })),
    total
  }
}

// 404s for unknown and stale (orphan) type keys. Hidden types stay reachable
// by URL — hiding removes a type from navigation, not from its data. A type
// owned by an app (contacts → crm) 410s while that app is off for the org.
export async function requireRecordType(tx: Tx, typeKey: string): Promise<RecordTypeSetting> {
  const type = await getRecordType(tx, typeKey)
  if (!type || type.orphan) {
    throw createError({ statusCode: 404, statusMessage: `Unknown record type: ${typeKey}` })
  }
  const app = type.manifest?.app
  if (app && !(await isAppEnabledForCurrentOrg(tx, app))) {
    throw createError({ statusCode: 410, statusMessage: `App "${app}" is not enabled for this organization.` })
  }
  return type
}

// The list visibility rule applied to a single record. 404 both for missing
// rows and for rows the caller may not see, so existence is never leaked.
export async function assertRecordVisible(
  tx: Tx,
  ctx: TenantContext,
  typeKey: string,
  recordId: string
): Promise<void> {
  if (!uuidSchema.safeParse(recordId).success) {
    throw createError({ statusCode: 404, statusMessage: 'Record not found.' })
  }
  let qb = tx
    .selectFrom('records_entries')
    .select('id')
    .where('id', '=', recordId)
    .where('record_type', '=', typeKey)
  if (!(await resolveTypePermission(tx, ctx, typeKey, 'view_all'))) {
    const type = await getRecordType(tx, typeKey)
    const scope = { key: typeKey, boardsGrantVisibility: type?.boardsGrantVisibility ?? true }
    qb = qb.where(eb => visibilityPredicate(eb, ctx.userId, scope))
  }
  const row = await qb.executeTakeFirst()
  if (!row) {
    throw createError({ statusCode: 404, statusMessage: 'Record not found.' })
  }
}
