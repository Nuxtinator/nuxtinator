// View access matrix + definition validation — every route goes through
// these instead of inlining its own queries.
//
// Access model: the owner (and the host `admin` role) holds every level;
// share rows grant 'view' or 'edit' but only while the view's visibility is
// not 'private' (flipping a view back to private instantly locks everyone
// out without deleting its shares); visibility 'org' grants a baseline
// 'view' to any caller that reached the route (which already required
// `workflows.use`). None of this widens CRM record access — what a viewer
// sees inside the view is still CRM's concern.

import { z } from 'zod'
import type { Selectable, Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { TenantContext } from '#tenant/server'
import { getRecordTypeFields } from '#crm/server'
import type { WorkflowsShareLevel } from '../database/schema'

type Tx = Transaction<Database>

export type WorkflowsViewRow = Selectable<Database['workflows_views']>
export type WorkflowsAccessLevel = 'view' | 'edit' | 'owner'

const LEVEL_RANK: Record<WorkflowsAccessLevel, number> = { view: 1, edit: 2, owner: 3 }

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

export interface WorkflowsColumnDef {
  key: string
  label: string
  color?: string
}

// Only explicit choices are stored; rendering defaults (card fields when
// unset, sort fallback, poll cadence) live in code.
export interface WorkflowsViewDefinition {
  /** Field-grouped kanban: the grouping field's key. XOR with `columns`. */
  groupField?: string
  /** Custom-column kanban: the board's own columns. XOR with `groupField`. */
  columns?: WorkflowsColumnDef[]
  /** Field keys shown on cards / as table columns (name is always shown). */
  cardFields?: string[]
  /** Saved shared filters, in CrmListOpts filter shape. */
  filters?: Record<string, unknown>
  sort?: { field: string, dir: 'asc' | 'desc' }
}

// Kinds a kanban can group by: single/multi selects (columns = options) and
// user references (columns = org users). Open vocabularies (tags) and
// unbounded kinds have no stable column set.
const GROUPABLE_KINDS = new Set(['key_select', 'multi_select', 'user_select'])

// Intrinsic record columns — always addressable even without a field def.
const INTRINSIC_KEYS = new Set(['name', 'status', 'created_at', 'updated_at'])

const columnSchema = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  label: z.string().min(1).max(80),
  color: z.string().max(32).optional()
}).strict()

export const workflowsDefinitionSchema = z.object({
  groupField: z.string().min(1).max(80).optional(),
  columns: z.array(columnSchema).min(1).max(50).optional(),
  cardFields: z.array(z.string().min(1).max(80)).max(20).optional(),
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
export async function sanitizeWorkflowsDefinition(
  tx: Tx,
  typeKey: string,
  viewType: 'kanban' | 'table',
  raw: unknown
): Promise<WorkflowsViewDefinition> {
  const parsed = workflowsDefinitionSchema.safeParse(raw ?? {})
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
    if (!GROUPABLE_KINDS.has(field.kind)) badDefinition(`field "${def.groupField}" (${field.kind}) cannot group a kanban`)
  }

  if (def.columns) {
    const keys = new Set(def.columns.map(c => c.key))
    if (keys.size !== def.columns.length) badDefinition('duplicate column keys')
  }

  for (const key of def.cardFields ?? []) {
    if (!known(key)) badDefinition(`unknown card field "${key}"`)
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

export async function getWorkflowsViewAccess(
  tx: Tx,
  ctx: TenantContext,
  view: Pick<WorkflowsViewRow, 'id' | 'owner_id' | 'visibility'>
): Promise<WorkflowsAccessLevel | null> {
  if (view.owner_id === ctx.userId || ctx.roles.includes('admin')) return 'owner'
  if (view.visibility === 'private') return null
  const share = await tx
    .selectFrom('workflows_view_shares')
    .select('level')
    .where('view_id', '=', view.id)
    .where('user_id', '=', ctx.userId)
    .executeTakeFirst()
  if (share) return share.level as WorkflowsShareLevel
  return view.visibility === 'org' ? 'view' : null
}

/**
 * Loads a view and asserts the caller holds at least `level` on it. An
 * unreachable view 404s (existence is not disclosed); an insufficient level
 * 403s.
 */
export async function requireWorkflowsView(
  tx: Tx,
  ctx: TenantContext,
  viewId: string,
  level: WorkflowsAccessLevel
): Promise<{ view: WorkflowsViewRow, access: WorkflowsAccessLevel }> {
  const view = await tx
    .selectFrom('workflows_views')
    .selectAll()
    .where('id', '=', viewId)
    .executeTakeFirst()
  if (!view) throw createError({ statusCode: 404, statusMessage: 'View not found' })
  const access = await getWorkflowsViewAccess(tx, ctx, view)
  if (!access) throw createError({ statusCode: 404, statusMessage: 'View not found' })
  if (LEVEL_RANK[access] < LEVEL_RANK[level]) {
    throw createError({ statusCode: 403, statusMessage: `View access required: ${level}` })
  }
  return { view, access }
}

// ---------------------------------------------------------------------------
// Listing + DTOs
// ---------------------------------------------------------------------------

export interface WorkflowsViewSummary {
  id: string
  name: string
  icon: string | null
  recordTypeKey: string
  viewType: 'kanban' | 'table'
  visibility: 'private' | 'shared' | 'org'
  ownerId: string
  ownerName: string
  accessLevel: WorkflowsAccessLevel
  createdAt: Date
  updatedAt: Date
}

export async function listWorkflowsViews(tx: Tx, ctx: TenantContext): Promise<WorkflowsViewSummary[]> {
  const isAdmin = ctx.roles.includes('admin')
  const rows = await tx
    .selectFrom('workflows_views as v')
    .innerJoin('users as u', 'u.id', 'v.owner_id')
    .leftJoin('workflows_view_shares as s', join => join
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
    let accessLevel: WorkflowsAccessLevel
    if (row.owner_id === ctx.userId || isAdmin) accessLevel = 'owner'
    else if (row.share_level) accessLevel = row.share_level as WorkflowsShareLevel
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

export function toWorkflowsViewDetail(view: WorkflowsViewRow, access: WorkflowsAccessLevel, ownerName: string) {
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
    definition: view.definition as WorkflowsViewDefinition,
    createdAt: view.created_at,
    updatedAt: view.updated_at
  }
}

export type WorkflowsViewDetail = ReturnType<typeof toWorkflowsViewDetail>
