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
// hand-picked records of views they can open for types that allow it (see
// boardVisibilitySource).
//
// A view holds tabs: the view owns the record type, sharing, base filter and
// hand-picked records; each tab owns its layout, grouping or columns, card
// fields, sort and its own filter, ANDed with the view's.

import { z } from 'zod'
import { sql } from 'kysely'
import type { Selectable, Transaction } from 'kysely'
import { generateKeyBetween } from 'fractional-indexing'
import type { Database } from '#core/server/database/schema'
import type { TenantContext } from '#tenant/server'
import {
  getRecordTypeFields,
  parseRecordsFilterGroup,
  requireRecordType,
  requireTypePermission,
  type RecordsFilterGroup
} from '#records/server'
import type { ViewsLayout, ViewsShareLevel } from '../database/schema'

type Tx = Transaction<Database>

export type ViewRow = Selectable<Database['views_definitions']>
export type ViewTabRow = Selectable<Database['views_tabs']>
export type ViewsAccessLevel = 'view' | 'edit' | 'owner'

const LEVEL_RANK: Record<ViewsAccessLevel, number> = { view: 1, edit: 2, owner: 3 }

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export interface ViewsColumnDef {
  key: string
  label: string
  color?: string
}

// What a view decides for all its tabs. Only explicit choices are stored.
export interface ViewDefinition {
  /** Base filter every tab narrows further. */
  filter?: RecordsFilterGroup
  /** Tabs show only the records added to the view by hand (views_items). */
  picked?: true
}

// What one tab decides. Rendering defaults (card fields when unset, sort
// fallback, poll cadence) live in code.
export interface ViewTabDefinition {
  /**
   * Board: the grouping field (XOR with `columns`). List: optional grouping
   * into sections.
   */
  groupField?: string
  /** Board of a hand-picked view: its own columns. XOR with `groupField`. */
  columns?: ViewsColumnDef[]
  /**
   * Field keys shown on cards, list rows and as table columns (name is always
   * shown). Absent = the record type's default card layout.
   */
  cardFields?: string[]
  /** Per connection card field: names, a count, or done-progress. Only with cardFields. */
  cardConnections?: Record<string, 'names' | 'count' | 'progress'>
  /** This tab's filter, ANDed with the view's base filter. */
  filter?: RecordsFilterGroup
  sort?: { field: string, dir: 'asc' | 'desc' }
}

export const VIEWS_LAYOUTS = ['kanban', 'table', 'list'] as const

export const VIEWS_LAYOUT_LABELS: Record<ViewsLayout, string> = {
  kanban: 'Board',
  table: 'Table',
  list: 'List'
}

// Kinds a board or list can group by: single/multi selects (columns = options),
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

export const viewsTabDefinitionSchema = z.object({
  groupField: z.string().min(1).max(80).optional(),
  columns: z.array(columnSchema).min(1).max(50).optional(),
  cardFields: z.array(z.string().min(1).max(80)).max(20).optional(),
  cardConnections: z.record(z.string(), z.enum(['names', 'count', 'progress'])).optional(),
  filter: z.unknown().optional(),
  sort: z.object({
    field: z.string().min(1).max(80),
    dir: z.enum(['asc', 'desc'])
  }).strict().optional()
}).strict()

const viewDefinitionSchema = z.object({
  filter: z.unknown().optional(),
  picked: z.literal(true).optional()
}).strict()

function badDefinition(message: string): never {
  throw createError({ statusCode: 400, statusMessage: `Invalid view definition: ${message}` })
}

/** An empty filter group is stored as no filter at all. */
function sanitizeFilter(raw: unknown, fields: Awaited<ReturnType<typeof getRecordTypeFields>>): RecordsFilterGroup | undefined {
  if (raw === undefined || raw === null) return undefined
  const group = parseRecordsFilterGroup(raw, fields)
  return group.rules.length > 0 ? group : undefined
}

/** Validates a view-level definition (base filter, hand-picked flag). */
export async function sanitizeViewDefinition(tx: Tx, typeKey: string, raw: unknown): Promise<ViewDefinition> {
  const parsed = viewDefinitionSchema.safeParse(raw ?? {})
  if (!parsed.success) badDefinition(parsed.error.issues[0]?.message ?? 'malformed')
  const fields = await getRecordTypeFields(tx, typeKey)
  const out: ViewDefinition = {}
  const filter = sanitizeFilter(parsed.data.filter, fields)
  if (filter) out.filter = filter
  if (parsed.data.picked) out.picked = true
  return out
}

/**
 * Validates a tab definition against its layout, its view, and the record
 * type's real fields, and returns it typed. Filter values are coerced later by
 * the list engine at read time; this guards the shape and the referenced keys.
 */
export async function sanitizeTabDefinition(
  tx: Tx,
  typeKey: string,
  layout: ViewsLayout,
  raw: unknown,
  opts: { picked: boolean }
): Promise<ViewTabDefinition> {
  const parsed = viewsTabDefinitionSchema.safeParse(raw ?? {})
  if (!parsed.success) badDefinition(parsed.error.issues[0]?.message ?? 'malformed')
  const { filter: rawFilter, ...rest } = parsed.data
  const def: ViewTabDefinition = { ...rest }

  if (layout === 'kanban') {
    if (!!def.groupField === !!def.columns) {
      badDefinition('a board needs exactly one of groupField or columns')
    }
    if (def.columns && !opts.picked) {
      badDefinition('a board with its own columns belongs to a view of hand-picked records')
    }
  } else if (def.columns) {
    badDefinition('only boards have their own columns')
  } else if (layout === 'table' && def.groupField) {
    badDefinition('tables are not grouped')
  }

  const fields = await getRecordTypeFields(tx, typeKey)
  const byKey = new Map(fields.map(f => [f.key, f]))
  const known = (key: string) => byKey.has(key) || INTRINSIC_KEYS.has(key)

  if (def.groupField) {
    const field = byKey.get(def.groupField)
    if (!field) badDefinition(`unknown grouping field "${def.groupField}"`)
    if (!VIEWS_GROUPABLE_KINDS.has(field.kind)) badDefinition(`field "${def.groupField}" (${field.kind}) cannot group records`)
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
  if (def.sort && !known(def.sort.field)) badDefinition(`unknown sort field "${def.sort.field}"`)

  const filter = sanitizeFilter(rawFilter, fields)
  if (filter) def.filter = filter
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
// Tabs
// ---------------------------------------------------------------------------

export async function listTabs(tx: Tx, viewId: string): Promise<ViewTabRow[]> {
  return await tx
    .selectFrom('views_tabs')
    .selectAll()
    .where('view_id', '=', viewId)
    .orderBy('position', 'asc')
    .orderBy('id', 'asc')
    .execute()
}

/** The view's tab `tabId`, or its first tab when none is named. */
export async function requireTab(tx: Tx, view: Pick<ViewRow, 'id'>, tabId?: string | null): Promise<ViewTabRow> {
  let query = tx.selectFrom('views_tabs').selectAll().where('view_id', '=', view.id)
  query = tabId
    ? query.where('id', '=', tabId)
    : query.orderBy('position', 'asc').orderBy('id', 'asc').limit(1)
  const tab = await query.executeTakeFirst()
  if (!tab) throw createError({ statusCode: 404, statusMessage: 'Tab not found' })
  return tab
}

export interface ViewTabInput {
  name?: string
  layout: ViewsLayout
  definition?: unknown
}

/** Adds a tab after the view's last one. */
export async function insertTab(tx: Tx, view: ViewRow, input: ViewTabInput): Promise<ViewTabRow> {
  const viewDef = view.definition as ViewDefinition
  const definition = await sanitizeTabDefinition(tx, view.record_type_key, input.layout, input.definition, {
    picked: !!viewDef.picked
  })
  const last = await tx
    .selectFrom('views_tabs')
    .select('position')
    .where('view_id', '=', view.id)
    .orderBy('position', 'desc')
    .limit(1)
    .executeTakeFirst()
  return await tx
    .insertInto('views_tabs')
    .values({
      view_id: view.id,
      name: input.name?.trim() || VIEWS_LAYOUT_LABELS[input.layout],
      layout: input.layout,
      position: generateKeyBetween(last?.position ?? null, null),
      // jsonb params bind reliably only through the text cast.
      definition: sql`${JSON.stringify(definition)}::text::jsonb`
    })
    .returningAll()
    .executeTakeFirstOrThrow()
}

export function toTabDetail(tab: ViewTabRow) {
  return {
    id: tab.id,
    name: tab.name,
    layout: tab.layout,
    position: tab.position,
    definition: tab.definition as ViewTabDefinition
  }
}

export type ViewTabDetail = ReturnType<typeof toTabDetail>

// ---------------------------------------------------------------------------
// Listing + DTOs
// ---------------------------------------------------------------------------

export interface ViewSummary {
  id: string
  name: string
  icon: string | null
  recordTypeKey: string
  /** The first tab's layout — what opening the view shows. */
  layout: ViewsLayout
  tabCount: number
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
      'v.id', 'v.name', 'v.icon', 'v.record_type_key', 'v.visibility',
      'v.owner_id', 'v.created_at', 'v.updated_at',
      'u.display_name as owner_name',
      's.level as share_level'
    ])
    .select(eb => [
      eb.selectFrom('views_tabs as t')
        .select('t.layout')
        .whereRef('t.view_id', '=', 'v.id')
        .orderBy('t.position', 'asc')
        .limit(1)
        .as('first_layout'),
      eb.selectFrom('views_tabs as t')
        .select(eb2 => eb2.fn.countAll<string>().as('n'))
        .whereRef('t.view_id', '=', 'v.id')
        .as('tab_count')
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
      layout: (row.first_layout ?? 'table') as ViewsLayout,
      tabCount: Number(row.tab_count ?? 0),
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
  tabs: ViewTabRow[],
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
    visibility: view.visibility,
    ownerId: view.owner_id,
    ownerName,
    accessLevel: access,
    sharedWithMe,
    definition: view.definition as ViewDefinition,
    tabs: tabs.map(toTabDetail),
    createdAt: view.created_at,
    updatedAt: view.updated_at
  }
}

export type ViewDetail = ReturnType<typeof toViewDetail>

/** The detail DTO for a view the caller already reached. */
export async function loadViewDetail(
  tx: Tx,
  view: ViewRow,
  access: ViewsAccessLevel,
  viaShare: boolean
): Promise<ViewDetail> {
  const owner = await tx
    .selectFrom('users')
    .select('display_name')
    .where('id', '=', view.owner_id)
    .executeTakeFirstOrThrow()
  return toViewDetail(view, await listTabs(tx, view.id), access, owner.display_name, viaShare)
}

export interface CreateViewInput {
  name: string
  icon?: string
  recordTypeKey: string
  visibility?: 'private' | 'shared' | 'org'
  /** View-level definition: base filter, hand-picked records. */
  definition?: unknown
  /** The view's first tab. */
  tab: ViewTabInput
}

/**
 * Creates a view owned by the caller, with its first tab. Requires read on
 * the record type (a view over a type you cannot read would always be empty)
 * and validates both definitions against the type's real fields.
 */
export async function createView(tx: Tx, ctx: TenantContext, input: CreateViewInput): Promise<ViewDetail> {
  await requireTypePermission(tx, ctx, input.recordTypeKey, 'read')
  await requireRecordType(tx, input.recordTypeKey)
  const definition = await sanitizeViewDefinition(tx, input.recordTypeKey, input.definition)
  const view = await tx
    .insertInto('views_definitions')
    .values({
      name: input.name,
      icon: input.icon ?? null,
      record_type_key: input.recordTypeKey,
      visibility: input.visibility ?? 'private',
      owner_id: ctx.userId,
      // jsonb params bind reliably only through the text cast.
      definition: sql`${JSON.stringify(definition)}::text::jsonb`
    })
    .returningAll()
    .executeTakeFirstOrThrow()
  await insertTab(tx, view, input.tab)
  return await loadViewDetail(tx, view, 'owner', false)
}
