// The records list engine — filter/sort/search compilation over the storage
// classes, plus the record-visibility rule shared by every read path.
//
// Filters and sorts address logical field keys; the compiler routes each to
// its physical home (see `storageOf` in #records): promoted columns become direct
// WHERE clauses, jsonb keys compare through data->>'key' with a kind-aware
// cast (number ::numeric, date/datetime ::timestamptz, boolean ::boolean),
// and the relational storages (entries, user refs, connections, attachments)
// compile to EXISTS subqueries; driver-backed storages (channels) compile through their
// registered driver. The intrinsic record columns — name, status,
// updated_at, created_at — are always addressable, even on admin-created
// types that have no code manifest.
//
// Visibility: a caller without <type>.view_all sees only records they created
// (records_entries.created_by), records shared with them (records_shares), or
// records naming them in an access-granting people field (an assignee,
// records_user_refs), plus
// whatever registered visibility sources grant (records on boards they can
// open) for types that allow it.
// Routes never inline these clauses — they go through `listRecords` /
// `assertRecordVisible`.

import { sql } from 'kysely'
import type { Expression, ExpressionBuilder, RawBuilder, SqlBool, Transaction } from 'kysely'
import { z } from 'zod'
import type { Database } from '#core/server/database/schema'
import { isAppEnabledForCurrentOrg, type TenantContext } from '#tenant/server'
import { APP_TEAM_GATE_MESSAGE, isAppOpenToUser } from '#core/server/utils/groups'
import { getRecordType, getRecordTypes, getRecordTypeFields, recordsAccessGrantingKeys, recordsStatusDefault, type RecordsFieldSetting, type RecordTypeSetting } from './definition-settings'
import { resolveTypePermission } from './type-permissions'
import type { RecordRow } from './record-storage'
import {
  isRecordsFilterGroup,
  recordsFilterOps,
  RECORDS_FILTER_INTRINSIC_KINDS,
  RECORDS_FILTER_MAX_DEPTH,
  RECORDS_FILTER_ME,
  RECORDS_FILTER_VALUE_SHAPE,
  type RecordsFilterGroup,
  type RecordsFilterRule
} from '../../client/filters'
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
   * Filter trees, each one ANDed with the others and with `filters` (a view's
   * base filter plus its tab's). Validated against the type's fields first.
   */
  where?: RecordsFilterGroup[]
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
  /**
   * Fields that aren't the type's own (a view's fields), addressable by
   * filter trees and sort like the type's fields.
   */
  virtualFields?: RecordsVirtualField[]
}

/**
 * A field kept outside the record (by another layer) that list queries can
 * still filter and sort on. Single-value kinds keep a jsonb scalar, every
 * other kind a jsonb array (people as user ids, files as file ids).
 */
export interface RecordsVirtualField {
  def: RecordsFieldSetting
  /** The field's jsonb value for the current `records_entries` row, null when unset. */
  value: () => RawBuilder<unknown>
}

/** Kinds a virtual field stores as one jsonb scalar; the rest store a jsonb array. */
export const RECORDS_VIRTUAL_SCALAR_KINDS = new Set(['text', 'textarea', 'number', 'boolean', 'date', 'datetime', 'key_select'])

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
    if (def.column === 'name') return sql.ref('records_entries.name')
    // An unset status reads as the type's default, so filters and sorts match what's shown.
    return typeof def.default === 'string'
      ? sql`coalesce(records_entries.status, ${def.default})`
      : sql.ref('records_entries.status')
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

// Attachments filter by presence only: "has files" / "has none".
function attachmentsCond(eb: Eb, def: RecordsFieldSetting, cond: FilterCond): Expression<SqlBool> {
  const base = eb.selectFrom('records_attachments as fa')
    .select('fa.id')
    .whereRef('fa.record_id', '=', 'records_entries.id')
    .where('fa.field_key', '=', def.key)
  if (cond.op === 'eq' && cond.value === null) return eb.not(eb.exists(base))
  return badFilter(def.key, `'${cond.op}' is not supported for attachments fields`)
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
      case 'attachments':
        return attachmentsCond(eb, def, cond)
    }
  })
  return conds.length === 1 ? conds[0]! : eb.and(conds)
}

// ---------------------------------------------------------------------------
// Filter trees (RecordsListOpts.where)
// ---------------------------------------------------------------------------

const MAX_TREE_RULES = 50

const filterRuleSchema = z.object({
  field: z.string().min(1).max(80),
  op: z.enum([
    'is', 'is_not', 'any_of', 'none_of', 'all_of', 'contains', 'empty', 'not_empty',
    'before', 'after', 'on', 'between', 'eq', 'lt', 'gt'
  ]),
  value: z.unknown().optional()
}).strict()

type GroupInput = { match: 'all' | 'any', rules: Array<z.infer<typeof filterRuleSchema> | GroupInput> }

const filterGroupSchema: z.ZodType<GroupInput> = z.lazy(() => z.object({
  match: z.enum(['all', 'any']),
  rules: z.array(z.union([filterRuleSchema, filterGroupSchema])).max(MAX_TREE_RULES)
}).strict())

function badTree(message: string): never {
  throw createError({ statusCode: 400, statusMessage: `Invalid filter: ${message}` })
}

const TIMESTAMP_KEYS = new Set(['created_at', 'updated_at'])

function timestampDef(key: string): RecordsFieldSetting {
  return { ...intrinsicColumnDef('name'), key, kind: 'datetime', column: undefined, label: key }
}

function resolveTreeDef(defsByKey: Map<string, RecordsFieldSetting>, key: string): RecordsFieldSetting | null {
  if (TIMESTAMP_KEYS.has(key)) return timestampDef(key)
  const def = resolveFieldDef(defsByKey, key)
  if (def && !defsByKey.has(key)) {
    return { ...def, kind: RECORDS_FILTER_INTRINSIC_KINDS[key] ?? def.kind }
  }
  return def
}

function ruleValues(rule: RecordsFilterRule): unknown[] {
  if (!Array.isArray(rule.value)) badTree(`${rule.field}: '${rule.op}' needs a list of values`)
  return rule.value
}

/**
 * Checks a filter tree's shape and every rule against the type's fields:
 * known field, an operator that field's kind offers, and a value of the
 * right shape. Values themselves are coerced (and 400 on garbage) when the
 * tree compiles.
 */
export function parseRecordsFilterGroup(
  raw: unknown,
  defs: RecordsFieldSetting[]
): RecordsFilterGroup {
  const parsed = filterGroupSchema.safeParse(raw)
  if (!parsed.success) badTree(parsed.error.issues[0]?.message ?? 'malformed')
  const defsByKey = new Map(defs.filter(d => !d.orphan).map(d => [d.key, d]))
  let count = 0
  const walk = (group: RecordsFilterGroup, depth: number) => {
    for (const node of group.rules) {
      if (isRecordsFilterGroup(node)) {
        if (depth >= RECORDS_FILTER_MAX_DEPTH) badTree('groups nest one level deep')
        walk(node, depth + 1)
        continue
      }
      if (++count > MAX_TREE_RULES) badTree(`at most ${MAX_TREE_RULES} rules`)
      const def = resolveTreeDef(defsByKey, node.field)
      if (!def) badTree(`unknown field "${node.field}"`)
      if (!recordsFilterOps(def.kind).includes(node.op)) {
        badTree(`${node.field}: '${node.op}' is not available for ${def.kind} fields`)
      }
      const shape = RECORDS_FILTER_VALUE_SHAPE[node.op]
      if (shape === 'none' && node.value !== undefined) badTree(`${node.field}: '${node.op}' takes no value`)
      if (shape === 'single' && (node.value === undefined || node.value === null || Array.isArray(node.value))) {
        badTree(`${node.field}: '${node.op}' needs one value`)
      }
      if (shape === 'list' && (!Array.isArray(node.value) || node.value.length === 0)) {
        badTree(`${node.field}: '${node.op}' needs at least one value`)
      }
      if (shape === 'range' && (!Array.isArray(node.value) || node.value.length !== 2)) {
        badTree(`${node.field}: '${node.op}' needs a from and a to value`)
      }
    }
  }
  const group = parsed.data as RecordsFilterGroup
  walk(group, 0)
  return group
}

// The left-hand side a scalar rule compares: a record column, a timestamp, or
// a kind-cast jsonb value.
function treeScalarLhs(def: RecordsFieldSetting): RawBuilder<unknown> {
  if (TIMESTAMP_KEYS.has(def.key) && def.storage === 'promoted' && !def.column) {
    return sql.ref(`records_entries.${def.key}`)
  }
  return scalarExpr(def)
}

const DATE_KINDS = new Set(['date', 'datetime'])

function scalarRule(
  eb: Eb,
  def: RecordsFieldSetting,
  rule: RecordsFilterRule,
  override?: { lhs: RawBuilder<unknown>, text: RawBuilder<unknown> }
): Expression<SqlBool> {
  const lhs = override?.lhs ?? treeScalarLhs(def)
  const textLike = def.kind === 'text' || def.kind === 'textarea'
  const empty = (): Expression<SqlBool> => textLike
    ? eb.or([eb(lhs, 'is', null), eb(lhs, '=', '')])
    : eb(lhs, 'is', null)
  // Dates compare by calendar day, so "on 2026-11-05" matches any time that day.
  const day = (v: unknown) => sql`(${coerceComparable(def, v)})::date`
  const dayLhs = sql`(${lhs})::date`
  switch (rule.op) {
    case 'empty': return empty()
    case 'not_empty': return eb.not(empty())
    case 'is':
    case 'eq':
      return eb(lhs, '=', coerceComparable(def, rule.value))
    case 'is_not':
      return eb.or([eb(lhs, 'is', null), eb(lhs, '<>', coerceComparable(def, rule.value))])
    case 'any_of':
      return eb(lhs, 'in', ruleValues(rule).map(v => coerceComparable(def, v)))
    case 'none_of':
      return eb.or([eb(lhs, 'is', null), eb(lhs, 'not in', ruleValues(rule).map(v => coerceComparable(def, v)))])
    case 'contains':
      return eb(override?.text ?? (def.storage === 'promoted' ? lhs : jsonbText(def.key)), 'ilike', likePattern(String(rule.value)))
    case 'on': return eb(dayLhs, '=', day(rule.value))
    case 'before': return eb(dayLhs, '<', day(rule.value))
    case 'after': return eb(dayLhs, '>', day(rule.value))
    case 'lt': return eb(lhs, '<', coerceComparable(def, rule.value))
    case 'gt': return eb(lhs, '>', coerceComparable(def, rule.value))
    case 'between': {
      const [from, to] = ruleValues(rule)
      if (DATE_KINDS.has(def.kind)) return eb.and([eb(dayLhs, '>=', day(from)), eb(dayLhs, '<=', day(to))])
      return eb.and([eb(lhs, '>=', coerceComparable(def, from)), eb(lhs, '<=', coerceComparable(def, to))])
    }
    default:
      return badTree(`${def.key}: '${rule.op}' is not available for ${def.kind} fields`)
  }
}

// Multi-value storages: each op is an EXISTS over the field's rows, built from
// the per-storage single conditions.
function multiRule(
  eb: Eb,
  def: RecordsFieldSetting,
  rule: RecordsFilterRule,
  cond: (c: FilterCond) => Expression<SqlBool>,
  resolve: (v: unknown) => unknown = v => v
): Expression<SqlBool> {
  const list = () => ruleValues(rule).map(v => resolve(v) as string)
  switch (rule.op) {
    case 'empty': return cond({ op: 'eq', value: null })
    case 'not_empty': return eb.not(cond({ op: 'eq', value: null }))
    case 'is': return cond({ op: 'eq', value: resolve(rule.value) })
    case 'any_of': return cond({ op: 'in', values: list() })
    case 'none_of': return eb.not(cond({ op: 'in', values: list() }))
    case 'all_of': return eb.and(list().map(value => cond({ op: 'eq', value })))
    case 'contains': return cond({ op: 'contains', value: String(rule.value) })
    default:
      return badTree(`${def.key}: '${rule.op}' is not available for ${def.kind} fields`)
  }
}

// A virtual scalar's comparison expression: its jsonb text, cast to the kind.
function virtualScalarExpr(vf: RecordsVirtualField): RawBuilder<unknown> {
  const text = sql`(${vf.value()} #>> '{}')`
  switch (vf.def.kind) {
    case 'number': return sql`(${text})::numeric`
    case 'boolean': return sql`(${text})::boolean`
    case 'date':
    case 'datetime': return sql`(${text})::timestamptz`
    default: return text
  }
}

// One condition over a virtual list field's jsonb array.
function virtualListCond(eb: Eb, vf: RecordsVirtualField, cond: FilterCond): Expression<SqlBool> {
  const list = sql`coalesce(${vf.value()}, '[]'::jsonb)`
  switch (cond.op) {
    case 'eq':
      if (cond.value === null) return sql<SqlBool>`jsonb_array_length(${list}) = 0`
      return sql<SqlBool>`${list} @> jsonb_build_array(${String(cond.value)}::text)`
    case 'in': {
      if (cond.values.length === 0) return sql<SqlBool>`false`
      return sql<SqlBool>`${list} ?| ${sql.val(cond.values.map(String))}::text[]`
    }
    case 'contains':
      return sql<SqlBool>`exists (select 1 from jsonb_array_elements_text(${list}) as e(v) where e.v ilike ${likePattern(cond.value)})`
    default:
      return badFilter(vf.def.key, `'${cond.op}' is not supported for ${vf.def.kind} fields`)
  }
}

function compileVirtualRule(eb: Eb, vf: RecordsVirtualField, rule: RecordsFilterRule, userId: string): Expression<SqlBool> {
  if (RECORDS_VIRTUAL_SCALAR_KINDS.has(vf.def.kind)) {
    return scalarRule(eb, vf.def, rule, { lhs: virtualScalarExpr(vf), text: sql`(${vf.value()} #>> '{}')` })
  }
  return multiRule(eb, vf.def, rule, c => virtualListCond(eb, vf, c), v => v === RECORDS_FILTER_ME ? userId : v)
}

function compileRule(eb: Eb, def: RecordsFieldSetting, rule: RecordsFilterRule, userId: string): Expression<SqlBool> {
  switch (def.storage) {
    case 'promoted':
    case 'jsonb':
      return scalarRule(eb, def, rule)
    case 'entries':
      return multiRule(eb, def, rule, c => entriesCond(eb, def, c))
    case 'user_refs':
      return multiRule(eb, def, rule, c => userRefsCond(eb, def, c), v => v === RECORDS_FILTER_ME ? userId : v)
    case 'connections':
      return multiRule(eb, def, rule, c => connectionsCond(eb, def, c))
    case 'channels':
      return multiRule(eb, def, rule, c => driverCond(eb, def, c))
    case 'attachments':
      return multiRule(eb, def, rule, c => attachmentsCond(eb, def, c))
  }
}

function compileFilterGroup(
  eb: Eb,
  group: RecordsFilterGroup,
  defsByKey: Map<string, RecordsFieldSetting>,
  userId: string,
  virtual: Map<string, RecordsVirtualField> = new Map()
): Expression<SqlBool> {
  const parts = group.rules.map((node) => {
    if (isRecordsFilterGroup(node)) return compileFilterGroup(eb, node, defsByKey, userId, virtual)
    const vf = virtual.get(node.field)
    if (vf) return compileVirtualRule(eb, vf, node, userId)
    const def = resolveTreeDef(defsByKey, node.field)
    if (!def) badTree(`unknown field "${node.field}"`)
    return compileRule(eb, def, node, userId)
  })
  if (parts.length === 0) return sql<SqlBool>`true`
  return group.match === 'all' ? eb.and(parts) : eb.or(parts)
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

/** Who may see a type's records without view_all, as visibilityPredicate needs it. */
export interface RecordsVisibilityScope {
  key: string
  boardsGrantVisibility: boolean
  /** People fields whose named users see the record (see recordsAccessGrantingKeys). */
  grantKeys: string[]
}

export function visibilityPredicate(
  eb: Eb,
  userId: string,
  type: RecordsVisibilityScope
): Expression<SqlBool> {
  const sources = type.boardsGrantVisibility
    ? getRecordsVisibilitySources().map(s => s.predicate(eb, { userId, typeKey: type.key }))
    : []
  const legs: Expression<SqlBool>[] = [
    // Creators always see their own records — without this leg, a caller
    // lacking view_all who creates a record of a type with no user-reference
    // field (most custom types) would lose sight of it the moment it saves.
    eb('records_entries.created_by', '=', userId),
    eb.exists(
      eb.selectFrom('records_shares as vs')
        .select('vs.record_id')
        .whereRef('vs.record_id', '=', 'records_entries.id')
        .where('vs.user_id', '=', userId)
    )
  ]
  if (type.grantKeys.length > 0) {
    legs.push(eb.exists(
      eb.selectFrom('records_user_refs as vu')
        .select('vu.record_id')
        .whereRef('vu.record_id', '=', 'records_entries.id')
        .where('vu.user_id', '=', userId)
        .where('vu.field_key', 'in', type.grantKeys)
    ))
  }
  return eb.or([...legs, ...sources])
}

/** The visibility scope of `typeKey` (its board rule and access-granting people fields). */
export async function recordsVisibilityScope(tx: Tx, typeKey: string): Promise<RecordsVisibilityScope> {
  const type = await getRecordType(tx, typeKey)
  const defs = await getRecordTypeFields(tx, typeKey)
  return {
    key: typeKey,
    boardsGrantVisibility: type?.boardsGrantVisibility ?? true,
    grantKeys: recordsAccessGrantingKeys(defs)
  }
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

/**
 * `maxLimit` raises the page-size cap for server callers that load a whole
 * board in one read; request-driven callers keep the default cap.
 */
export async function listRecords(
  tx: Tx,
  ctx: TenantContext,
  typeKey: string,
  opts: RecordsListOpts = {},
  { maxLimit = MAX_LIMIT }: { maxLimit?: number } = {}
): Promise<RecordsListResult> {
  // Stale orphan rows describe nothing filterable; real fields only.
  const defs = (await getRecordTypeFields(tx, typeKey)).filter(d => !d.orphan)
  const defsByKey = new Map(defs.map(d => [d.key, d]))

  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), maxLimit)
  const offset = Math.max(opts.offset ?? 0, 0)
  const dir = opts.dir ?? 'desc'

  const preds: Array<(eb: Eb) => Expression<SqlBool>> = []
  for (const [key, raw] of Object.entries(opts.filters ?? {})) {
    const def = resolveFieldDef(defsByKey, key)
    if (!def) throw createError({ statusCode: 400, statusMessage: `Unknown filter field: ${key}` })
    preds.push(eb => filterPredicate(eb, def, raw))
  }
  const virtual = new Map((opts.virtualFields ?? []).map(vf => [vf.def.key, vf]))
  const treeDefs = [...defs, ...(opts.virtualFields ?? []).map(vf => vf.def)]
  for (const raw of opts.where ?? []) {
    const group = parseRecordsFilterGroup(raw, treeDefs)
    preds.push(eb => compileFilterGroup(eb, group, defsByKey, ctx.userId, virtual))
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
    const scope = await recordsVisibilityScope(tx, typeKey)
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
  const sortVirtual = virtual.get(sortKey)
  if (sortKey === 'updated_at' || sortKey === 'created_at') {
    query = query.orderBy(`records_entries.${sortKey}`, dir)
  } else if (sortVirtual) {
    if (!RECORDS_VIRTUAL_SCALAR_KINDS.has(sortVirtual.def.kind)) {
      throw createError({ statusCode: 400, statusMessage: `Cannot sort by field: ${sortKey}` })
    }
    query = query.orderBy(virtualScalarExpr(sortVirtual), dir)
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

  const statusDefault = recordsStatusDefault(defs)
  return {
    items: rows.map(row => ({ ...row, status: row.status ?? statusDefault, assignedTo: assigned.get(row.id) ?? [] })),
    total
  }
}

// 404s for unknown and stale (orphan) type keys. Hidden types stay reachable
// by URL — hiding removes a type from navigation, not from its data. The app
// that owns the type (contacts → crm; the records app for types without one)
// gates its records the way a route's `appId` would: 410 while the app is off
// for the org, 403 when its access list names teams the caller is not on.
export async function requireRecordType(tx: Tx, typeKey: string, ctx: TenantContext): Promise<RecordTypeSetting> {
  const type = await getRecordType(tx, typeKey)
  if (!type || type.orphan) {
    throw createError({ statusCode: 404, statusMessage: `Unknown record type: ${typeKey}` })
  }
  const app = type.manifest?.app ?? 'records'
  if (!(await isAppEnabledForCurrentOrg(tx, app))) {
    throw createError({ statusCode: 410, statusMessage: `App "${app}" is not enabled for this organization.` })
  }
  if (!(await isAppOpenToUser(tx, { appId: app, orgId: ctx.orgId, userId: ctx.userId }))) {
    throw createError({ statusCode: 403, statusMessage: APP_TEAM_GATE_MESSAGE })
  }
  return type
}

/**
 * 403 unless the caller can read some record type whose app is open to them:
 * the gate for surfaces that serve every type, like the user directory.
 */
export async function requireAnyRecordTypeRead(tx: Tx, ctx: TenantContext): Promise<void> {
  for (const type of await getRecordTypes(tx)) {
    if (type.orphan) continue
    if (!(await resolveTypePermission(tx, ctx, type.key, 'read'))) continue
    try {
      await requireRecordType(tx, type.key, ctx)
      return
    } catch {
      continue
    }
  }
  throw createError({ statusCode: 403, statusMessage: 'Permission required: read access to a record type' })
}

/**
 * The ids among `ids` the caller may open: per record type, the type's read
 * permission, its app gate and the record-visibility rule.
 */
export async function visibleRecordIds(tx: Tx, ctx: TenantContext, ids: string[]): Promise<Set<string>> {
  const visible = new Set<string>()
  if (ids.length === 0) return visible
  const rows = await tx
    .selectFrom('records_entries')
    .select(['id', 'record_type'])
    .where('id', 'in', ids)
    .execute()
  const byType = new Map<string, string[]>()
  for (const row of rows) {
    const list = byType.get(row.record_type) ?? []
    list.push(row.id)
    byType.set(row.record_type, list)
  }
  for (const [typeKey, typeIds] of byType) {
    if (!(await resolveTypePermission(tx, ctx, typeKey, 'read'))) continue
    try {
      await requireRecordType(tx, typeKey, ctx)
    } catch {
      continue
    }
    if (await resolveTypePermission(tx, ctx, typeKey, 'view_all')) {
      for (const id of typeIds) visible.add(id)
      continue
    }
    const scope = await recordsVisibilityScope(tx, typeKey)
    const seen = await tx
      .selectFrom('records_entries')
      .select('id')
      .where('id', 'in', typeIds)
      .where(eb => visibilityPredicate(eb, ctx.userId, scope))
      .execute()
    for (const r of seen) visible.add(r.id)
  }
  return visible
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
    const scope = await recordsVisibilityScope(tx, typeKey)
    qb = qb.where(eb => visibilityPredicate(eb, ctx.userId, scope))
  }
  const row = await qb.executeTakeFirst()
  if (!row) {
    throw createError({ statusCode: 404, statusMessage: 'Record not found.' })
  }
}
