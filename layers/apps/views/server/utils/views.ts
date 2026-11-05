// View access matrix + definition validation — every route goes through
// these instead of inlining its own queries.
//
// Access model: the owner (and the host `admin` role) holds every level;
// share rows grant 'view' or 'edit' but only while the view's visibility is
// not 'private' (flipping a view back to private instantly locks everyone
// out without deleting its shares); visibility 'org' grants a baseline
// 'view' to any caller that reached the route (which already required
// `views.use`). Opening a view never widens record access by itself — what
// a viewer sees inside it is the records kernel's answer, which includes the
// cards on custom boards they can open for types that allow it (see
// boardVisibilitySource).

import { z } from 'zod'
import { sql } from 'kysely'
import type { Selectable, Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { TenantContext } from '#tenant/server'
import { getRecordTypeFields, requireRecordType, requireTypePermission } from '#records/server'
import type { ViewsShareLevel } from '../database/schema'

type Tx = Transaction<Database>

export type ViewRow = Selectable<Database['views_definitions']>
export type ViewsAccessLevel = 'view' | 'edit' | 'owner'

const LEVEL_RANK: Record<ViewsAccessLevel, number> = { view: 1, edit: 2, owner: 3 }

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

export interface ViewsColumnDef {
  key: string
  label: string
  color?: string
}

// Only explicit choices are stored; rendering defaults (card fields when
// unset, sort fallback, poll cadence) live in code.
export interface ViewDefinition {
  /** Field-grouped kanban: the grouping field's key. XOR with `columns`. */
  groupField?: string
  /** Custom-column kanban: the board's own columns. XOR with `groupField`. */
  columns?: ViewsColumnDef[]
  /**
   * Field keys shown on cards / as table columns (name is always shown).
   * Absent = the record type's default card layout.
   */
  cardFields?: string[]
  /** Per connection card field: names, a count, or done-progress. Only with cardFields. */
  cardConnections?: Record<string, 'names' | 'count' | 'progress'>
  /** Saved shared filters, in RecordsListOpts filter shape. */
  filters?: Record<string, unknown>
  sort?: { field: string, dir: 'asc' | 'desc' }
}

// Kinds a kanban can group by: single/multi selects (columns = options),
// user references (columns = users with cards), tags (columns = tags in use)
// and connections (columns = the target type's records).
export const VIEWS_GROUPABLE_KINDS = new Set(['key_select', 'multi_select', 'user_select', 'tags', 'connection'])

// Intrinsic record columns — always addressable even without a field def.
const INTRINSIC_KEYS = new Set(['name', 'status', 'created_at', 'updated_at'])

const columnSchema = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  label: z.string().min(1).max(80),
  color: z.string().max(32).optional()
}).strict()

export const viewsDefinitionSchema = z.object({
  groupField: z.string().min(1).max(80).optional(),
  columns: z.array(columnSchema).min(1).max(50).optional(),
  cardFields: z.array(z.string().min(1).max(80)).max(20).optional(),
  cardConnections: z.record(z.string(), z.enum(['names', 'count', 'progress'])).optional(),
  filters: z.record(z.string(), z.unknown()).optional(),
  sort: z.object({
    field: z.string().min(1).max(80),
    dir: z.enum(['asc', 'desc'])
  }).strict().optional()
}).strict()

function badDefinition(message: string): never {
  throw createError({ statusCode: 400, statusMessage: `Invalid view definition: ${message}` })
}

/**
 * Validates a raw definition against the record type's real fields and
 * returns it typed. Filter/sort *values* are validated later by the list
 * engine at read time; this guards the shape and the referenced keys.
 */
export async function sanitizeViewsDefinition(
  tx: Tx,
  typeKey: string,
  viewType: 'kanban' | 'table',
  raw: unknown
): Promise<ViewDefinition> {
  const parsed = viewsDefinitionSchema.safeParse(raw ?? {})
  if (!parsed.success) badDefinition(parsed.error.issues[0]?.message ?? 'malformed')
  const def = parsed.data

  if (viewType === 'kanban') {
    if (!!def.groupField === !!def.columns) {
      badDefinition('a kanban view needs exactly one of groupField or columns')
    }
  } else if (def.groupField || def.columns) {
    badDefinition('grouping only applies to kanban views')
  }

  const fields = await getRecordTypeFields(tx, typeKey)
  const byKey = new Map(fields.map(f => [f.key, f]))
  const known = (key: string) => byKey.has(key) || INTRINSIC_KEYS.has(key)

  if (def.groupField) {
    const field = byKey.get(def.groupField)
    if (!field) badDefinition(`unknown grouping field "${def.groupField}"`)
    if (!VIEWS_GROUPABLE_KINDS.has(field.kind)) badDefinition(`field "${def.groupField}" (${field.kind}) cannot group a kanban`)
  }

  if (def.columns) {
    const keys = new Set(def.columns.map(c => c.key))
    if (keys.size !== def.columns.length) badDefinition('duplicate column keys')
  }

  for (const key of def.cardFields ?? []) {
    if (!known(key)) badDefinition(`unknown card field "${key}"`)
  }
  if (def.cardConnections) {
    if (!def.cardFields) badDefinition('cardConnections only applies with cardFields')
    for (const key of Object.keys(def.cardConnections)) {
      if (byKey.get(key)?.kind !== 'connection') badDefinition(`"${key}" is not a connection field`)
    }
  }
  for (const key of Object.keys(def.filters ?? {})) {
    if (!known(key)) badDefinition(`unknown filter field "${key}"`)
  }
  if (def.sort && !known(def.sort.field)) badDefinition(`unknown sort field "${def.sort.field}"`)

  return def
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

export interface ViewAccess {
  level: ViewsAccessLevel
  /**
   * The caller holds a share row on this view rather than reaching it through
   * its org visibility — the one case where leaving the view is theirs to do.
   */
  viaShare: boolean
}

export async function getViewAccess(
  tx: Tx,
  ctx: TenantContext,
  view: Pick<ViewRow, 'id' | 'owner_id' | 'visibility'>
): Promise<ViewAccess | null> {
  if (view.owner_id === ctx.userId || ctx.roles.includes('admin')) {
    return { level: 'owner', viaShare: false }
  }
  if (view.visibility === 'private') return null
  const share = await tx
    .selectFrom('views_shares')
    .select('level')
    .where('view_id', '=', view.id)
    .where('user_id', '=', ctx.userId)
    .executeTakeFirst()
  if (share) return { level: share.level as ViewsShareLevel, viaShare: true }
  return view.visibility === 'org' ? { level: 'view', viaShare: false } : null
}

/**
 * Loads a view and asserts the caller holds at least `level` on it. An
 * unreachable view 404s (existence is not disclosed); an insufficient level
 * 403s.
 */
export async function requireView(
  tx: Tx,
  ctx: TenantContext,
  viewId: string,
  level: ViewsAccessLevel
): Promise<{ view: ViewRow, access: ViewsAccessLevel, viaShare: boolean }> {
  const view = await tx
    .selectFrom('views_definitions')
    .selectAll()
    .where('id', '=', viewId)
    .executeTakeFirst()
  if (!view) throw createError({ statusCode: 404, statusMessage: 'View not found' })
  const access = await getViewAccess(tx, ctx, view)
  if (!access) throw createError({ statusCode: 404, statusMessage: 'View not found' })
  if (LEVEL_RANK[access.level] < LEVEL_RANK[level]) {
    throw createError({ statusCode: 403, statusMessage: `View access required: ${level}` })
  }
  return { view, access: access.level, viaShare: access.viaShare }
}

// ---------------------------------------------------------------------------
// Listing + DTOs
// ---------------------------------------------------------------------------

export interface ViewSummary {
  id: string
  name: string
  icon: string | null
  recordTypeKey: string
  viewType: 'kanban' | 'table'
  visibility: 'private' | 'shared' | 'org'
  ownerId: string
  ownerName: string
  accessLevel: ViewsAccessLevel
  createdAt: Date
  updatedAt: Date
}

export async function listViews(tx: Tx, ctx: TenantContext): Promise<ViewSummary[]> {
  const isAdmin = ctx.roles.includes('admin')
  const rows = await tx
    .selectFrom('views_definitions as v')
    .innerJoin('users as u', 'u.id', 'v.owner_id')
    .leftJoin('views_shares as s', join => join
      .onRef('s.view_id', '=', 'v.id')
      .on('s.user_id', '=', ctx.userId))
    .where(eb => eb.or([
      eb('v.owner_id', '=', ctx.userId),
      eb('v.visibility', '=', 'org'),
      eb.and([eb('v.visibility', '=', 'shared'), eb('s.user_id', 'is not', null)])
    ]))
    .select([
      'v.id', 'v.name', 'v.icon', 'v.record_type_key', 'v.view_type', 'v.visibility',
      'v.owner_id', 'v.created_at', 'v.updated_at',
      'u.display_name as owner_name',
      's.level as share_level'
    ])
    .orderBy('v.updated_at', 'desc')
    .execute()

  return rows.map((row) => {
    let accessLevel: ViewsAccessLevel
    if (row.owner_id === ctx.userId || isAdmin) accessLevel = 'owner'
    else if (row.share_level) accessLevel = row.share_level as ViewsShareLevel
    else accessLevel = 'view'
    return {
      id: row.id,
      name: row.name,
      icon: row.icon,
      recordTypeKey: row.record_type_key,
      viewType: row.view_type,
      visibility: row.visibility,
      ownerId: row.owner_id,
      ownerName: row.owner_name,
      accessLevel,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  })
}

export function toViewDetail(
  view: ViewRow,
  access: ViewsAccessLevel,
  ownerName: string,
  /** Whether the caller reached the view through a share row of their own. */
  sharedWithMe = false
) {
  return {
    id: view.id,
    name: view.name,
    icon: view.icon,
    recordTypeKey: view.record_type_key,
    viewType: view.view_type,
    visibility: view.visibility,
    ownerId: view.owner_id,
    ownerName,
    accessLevel: access,
    sharedWithMe,
    definition: view.definition as ViewDefinition,
    createdAt: view.created_at,
    updatedAt: view.updated_at
  }
}

export type ViewDetail = ReturnType<typeof toViewDetail>

export interface CreateViewInput {
  name: string
  icon?: string
  recordTypeKey: string
  viewType: 'kanban' | 'table'
  visibility?: 'private' | 'shared' | 'org'
  definition?: unknown
}

/**
 * Creates a view owned by the caller. Requires read on the record type (a
 * view over a type you cannot read would always be empty) and validates the
 * definition against the type's real fields.
 */
export async function createView(tx: Tx, ctx: TenantContext, input: CreateViewInput): Promise<ViewDetail> {
  await requireTypePermission(tx, ctx, input.recordTypeKey, 'read')
  await requireRecordType(tx, input.recordTypeKey)
  const definition = await sanitizeViewsDefinition(tx, input.recordTypeKey, input.viewType, input.definition)
  const view = await tx
    .insertInto('views_definitions')
    .values({
      name: input.name,
      icon: input.icon ?? null,
      record_type_key: input.recordTypeKey,
      view_type: input.viewType,
      visibility: input.visibility ?? 'private',
      owner_id: ctx.userId,
      // jsonb params bind reliably only through the text cast.
      definition: sql`${JSON.stringify(definition)}::text::jsonb`
    })
    .returningAll()
    .executeTakeFirstOrThrow()
  const owner = await tx
    .selectFrom('users')
    .select('display_name')
    .where('id', '=', ctx.userId)
    .executeTakeFirstOrThrow()
  return toViewDetail(view, 'owner', owner.display_name)
}
