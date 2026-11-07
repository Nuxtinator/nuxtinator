// View access matrix + definition validation — every route goes through
// these instead of inlining its own queries.
//
// Access model: the owner (and the host `admin` role) holds every level.
// Everyone else's level is the highest of their share row, their teams' rows
// on a 'teams' view and Everyone's level on an 'org' view ('view' unless
// 'edit' is stored). 'view' opens the view; 'edit' also edits its tabs; the
// owner alone decides who can open it, its base filter, and deletes it.
// A view that shows every matching record grants nothing on records — what a
// viewer sees in it is the records kernel's answer. A hand-picked view shares
// its cards: everyone who can open it sees them, and 'edit' edits them (see
// board-visibility.ts).
//
// A view holds tabs: the view owns the record type, sharing, base filter and
// hand-picked records; each tab owns its layout, grouping or columns, card
// fields, sort and its own filter, ANDed with the view's.

import { z } from 'zod'
import { sql } from 'kysely'
import type { RawBuilder, Selectable, SqlBool, Transaction } from 'kysely'
import { generateKeyBetween } from 'fractional-indexing'
import type { Database } from '#core/server/database/schema'
import { isActiveOrgMember, type TenantContext } from '#tenant/server'
import {
  getRecordType,
  getRecordTypeFields,
  parseRecordsFilterGroup,
  requireRecordType,
  requireTypePermission,
  type RecordsFilterGroup
} from '#records/server'
import { getContainerTeams, type ContainerTeam } from '#core/server/utils/team-access'
import type { ViewsLayout, ViewsShareLevel, ViewsVisibility } from '../database/schema'

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
  /**
   * Board: its own columns (XOR with `groupField`). A card's column is its
   * placement on the tab; in a view that isn't hand-picked, records without
   * one sit in a leading "No column" lane.
   */
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
  columns: z.array(columnSchema).max(50).optional(),
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

/** Whether listRecords can sort by `key`: the record row's own columns and jsonb fields. */
export function isSortableField(fields: Awaited<ReturnType<typeof getRecordTypeFields>>, key: string): boolean {
  if (INTRINSIC_KEYS.has(key)) return true
  const field = fields.find(f => f.key === key && !f.orphan)
  return !!field && (field.storage === 'promoted' || field.storage === 'jsonb')
}

/**
 * Validates a tab definition against its layout and the record
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
    // A hand-picked view's cards always sit in one of its columns; elsewhere
    // the "No column" lane holds the rest.
    if (opts.picked && def.columns?.length === 0) {
      badDefinition('a board of hand-picked records needs at least one column')
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
  if (def.sort && !isSortableField(fields, def.sort.field)) badDefinition(`records cannot be sorted by "${def.sort.field}"`)

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

/**
 * Whether `userId` reaches the view (aliased `alias` in the query) through
 * its visibility: org-wide, or a 'teams' view with one of their teams.
 */
export function viewOpenToUser(alias: string, userId: string): RawBuilder<SqlBool> {
  const col = (name: string) => sql.ref(`${alias}.${name}`)
  return sql<SqlBool>`(${col('visibility')} = 'org' or (${col('visibility')} = 'teams' and exists (
    select 1 from views_teams vt join group_members gm on gm.group_id = vt.group_id
    where vt.container_id = ${col('id')} and gm.user_id = ${userId}::uuid
  )))`
}

/**
 * Whether `userId` holds 'edit' or more on the view (aliased `alias`): its
 * owner, an edit share, Everyone at 'edit' on an org-wide view, or one of
 * their teams at 'edit'.
 */
export function viewEditableByUser(alias: string, userId: string): RawBuilder<SqlBool> {
  const col = (name: string) => sql.ref(`${alias}.${name}`)
  return sql<SqlBool>`(
    ${col('owner_id')} = ${userId}::uuid
    or exists (select 1 from views_shares es where es.view_id = ${col('id')} and es.user_id = ${userId}::uuid and es.level = 'edit')
    or (${col('visibility')} = 'org' and ${col('org_level')} = 'edit')
    or (${col('visibility')} = 'teams' and exists (
      select 1 from views_teams et join group_members egm on egm.group_id = et.group_id
      where et.container_id = ${col('id')} and egm.user_id = ${userId}::uuid and et.level = 'edit'
    ))
  )`
}

function maxLevel(a: ViewsShareLevel | null, b: ViewsShareLevel | null): ViewsShareLevel | null {
  if (a === 'edit' || b === 'edit') return 'edit'
  return a ?? b
}

export async function getViewAccess(
  tx: Tx,
  ctx: TenantContext,
  view: Pick<ViewRow, 'id' | 'owner_id' | 'visibility' | 'org_level'>
): Promise<ViewAccess | null> {
  if (view.owner_id === ctx.userId || ctx.roles.includes('admin')) {
    return { level: 'owner', viaShare: false }
  }
  const share = await tx
    .selectFrom('views_shares')
    .select('level')
    .where('view_id', '=', view.id)
    .where('user_id', '=', ctx.userId)
    .executeTakeFirst()
  let reached: ViewsShareLevel | null = null
  if (view.visibility === 'org') {
    reached = view.org_level ?? 'view'
  } else if (view.visibility === 'teams') {
    const teams = await tx
      .selectFrom('views_teams as vt')
      .innerJoin('group_members as gm', 'gm.group_id', 'vt.group_id')
      .select('vt.level')
      .where('vt.container_id', '=', view.id)
      .where('gm.user_id', '=', ctx.userId)
      .execute()
    for (const t of teams) reached = maxLevel(reached, t.level ?? 'view')
  }
  const level = maxLevel((share?.level as ViewsShareLevel | undefined) ?? null, reached)
  return level ? { level, viaShare: !!share } : null
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
  const definition = await sanitizeTabDefinition(tx, view.record_type_key, input.layout, input.definition, {
    picked: !!(view.definition as ViewDefinition).picked
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
  visibility: ViewsVisibility
  ownerId: string
  ownerName: string
  accessLevel: ViewsAccessLevel
  /** The teams a view with visibility 'teams' opens to. */
  teams: ContainerTeam[]
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
      eb('s.user_id', 'is not', null),
      viewOpenToUser('v', ctx.userId)
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
        .as('tab_count'),
      viewEditableByUser('v', ctx.userId).as('can_edit')
    ])
    .orderBy('v.updated_at', 'desc')
    .execute()

  const teamsByView = await getContainerTeams(
    tx, 'views_definitions', rows.filter(r => r.visibility === 'teams').map(r => r.id))

  return rows.map((row) => {
    let accessLevel: ViewsAccessLevel
    if (row.owner_id === ctx.userId || isAdmin) accessLevel = 'owner'
    else accessLevel = row.can_edit ? 'edit' : 'view'
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
      teams: teamsByView.get(row.id) ?? [],
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
  sharedWithMe = false,
  teams: Array<ContainerTeam & { level: ViewsShareLevel }> = [],
  /** Records created on this hand-picked view and on no other — what deleting it deletes. */
  ownCardCount = 0
) {
  return {
    id: view.id,
    name: view.name,
    icon: view.icon,
    recordTypeKey: view.record_type_key,
    visibility: view.visibility,
    orgLevel: (view.org_level ?? 'view') as ViewsShareLevel,
    ownCardCount,
    ownerId: view.owner_id,
    ownerName,
    accessLevel: access,
    sharedWithMe,
    teams,
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
  const levels = new Map((await tx
    .selectFrom('views_teams')
    .select(['group_id', 'level'])
    .where('container_id', '=', view.id)
    .execute()).map(r => [r.group_id, (r.level ?? 'view') as ViewsShareLevel]))
  const teams = ((await getContainerTeams(tx, 'views_definitions', [view.id])).get(view.id) ?? [])
    .map(t => ({ ...t, level: levels.get(t.id) ?? 'view' as ViewsShareLevel }))
  const ownCardCount = await ownsItsCards(tx, view) ? await countOwnCards(tx, view.id) : 0
  return toViewDetail(view, await listTabs(tx, view.id), access, owner.display_name, viaShare, teams, ownCardCount)
}

/**
 * Whether the view's own cards (records created on it) are its to delete: a
 * hand-picked view over a type whose boards grant visibility.
 */
export async function ownsItsCards(tx: Tx, view: Pick<ViewRow, 'definition' | 'record_type_key'>): Promise<boolean> {
  if (!(view.definition as ViewDefinition).picked) return false
  return (await getRecordType(tx, view.record_type_key))?.boardsGrantVisibility ?? false
}

/** Records created on the view that no other view holds. */
export function ownCardsQuery(tx: Tx, viewId: string) {
  return tx
    .selectFrom('views_items as i')
    .where('i.view_id', '=', viewId)
    .where('i.created_here', '=', true)
    .where(eb => eb.not(eb.exists(
      eb.selectFrom('views_items as o')
        .select('o.record_id')
        .whereRef('o.record_id', '=', 'i.record_id')
        .where('o.view_id', '<>', viewId)
    )))
}

/**
 * Deletes a view together with its own cards (records created on it that no
 * other view holds). Shares, tabs and placements go via FK cascade.
 */
export async function deleteViewWithOwnCards(
  tx: Tx,
  view: Pick<ViewRow, 'id' | 'definition' | 'record_type_key'>
): Promise<void> {
  const own = await ownsItsCards(tx, view) ? await ownCardsQuery(tx, view.id).select('i.record_id').execute() : []
  if (own.length > 0) {
    await tx.deleteFrom('records_entries').where('id', 'in', own.map(r => r.record_id)).execute()
  }
  await tx.deleteFrom('views_definitions').where('id', '=', view.id).execute()
}

/** 404s unless `userId` is a user in the org bound to the transaction (any user in single mode). */
export async function requireOrgUser(tx: Tx, userId: string): Promise<void> {
  const user = await tx
    .selectFrom('users')
    .select('id')
    .where('id', '=', userId)
    .executeTakeFirst()
  if (!user || !(await isActiveOrgMember(tx, userId))) {
    throw createError({ statusCode: 404, statusMessage: 'User not found' })
  }
}

async function countOwnCards(tx: Tx, viewId: string): Promise<number> {
  const row = await ownCardsQuery(tx, viewId)
    .select(eb => eb.fn.countAll<string>().as('n'))
    .executeTakeFirst()
  return Number(row?.n ?? 0)
}

/**
 * Sets who a view opens to and at which level: Everyone's level on an
 * org-wide view, each team's on a 'teams' view. Only 'edit' is stored.
 */
export async function setViewLevels(
  tx: Tx,
  viewId: string,
  input: { visibility: ViewsVisibility, orgLevel?: ViewsShareLevel, teamLevels?: Record<string, ViewsShareLevel> }
): Promise<void> {
  await tx
    .updateTable('views_definitions')
    .set({ org_level: input.visibility === 'org' && input.orgLevel === 'edit' ? 'edit' : null })
    .where('id', '=', viewId)
    .execute()
  if (input.visibility !== 'teams') return
  const edit = Object.entries(input.teamLevels ?? {}).filter(([, l]) => l === 'edit').map(([id]) => id)
  await tx.updateTable('views_teams').set({ level: null }).where('container_id', '=', viewId).execute()
  if (edit.length > 0) {
    await tx
      .updateTable('views_teams')
      .set({ level: 'edit' })
      .where('container_id', '=', viewId)
      .where('group_id', 'in', edit)
      .execute()
  }
}

export interface CreateViewInput {
  name: string
  icon?: string
  recordTypeKey: string
  visibility?: 'private' | 'org'
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
  await requireRecordType(tx, input.recordTypeKey, ctx)
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
