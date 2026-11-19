// Built-in views: views declared in code (by this layer or another one)
// instead of stored as rows. Everyone who can read the view's record type
// opens them; nobody can change them, so they're opened at 'view' — cards
// still move between field-grouped columns and get added through the
// records routes, and "Copy view" turns one into a view of your own.
//
// A built-in may take a parameter (a meeting's id, a task's id), which its
// filters use. Parameterized built-ins aren't listed; they're opened for one
// value, e.g. embedded on that meeting's page, or as the board of one task's
// subtasks. One that stands for a record names it and the views above it
// (the same built-in for the record's ancestors), which the header shows as
// a trail.
//
// Ids: `builtin.<key>` and `builtin.<key>.<param>`. Inside the server a
// built-in reads as a ViewRow (and its tabs as ViewTabRows) whose ids are
// stable uuids derived from those ids, so view-keyed queries match no rows.

import { createHash } from 'node:crypto'
import { generateNKeysBetween } from 'fractional-indexing'
import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { TenantContext } from '#tenant/server'
import { getRecordType, resolveTypePermission, type RecordsFilterGroup } from '#records/server'
import type { ViewsLayout } from '../database/schema'
import type { ViewDefinition, ViewRow, ViewTabDefinition, ViewTabRow } from './views'

type Tx = Transaction<Database>

export const VIEWS_BUILTIN_PREFIX = 'builtin.'

export interface ViewsBuiltInTab {
  /** Stable within the view; [a-z0-9-]. */
  key: string
  name: string
  layout: ViewsLayout
  definition: ViewTabDefinition
  /** The tab's filter, given the view's parameter; replaces `definition.filter`. */
  filter?: (param: string | null) => RecordsFilterGroup
}

/** What a parameterized built-in opens as for one parameter value. */
export interface ViewsBuiltInTarget {
  name: string
  /** The record the view stands for: its header opens it. */
  recordId?: string
  /** That record's type, which can differ from the type the view shows (a deliverable's tasks). */
  recordType?: string
  /** The same built-in's views above this one, outermost first, by parameter. */
  trail?: Array<{ param: string, name: string }>
  /** The record type the view shows for this parameter, when not the view's own. */
  recordTypeKey?: string
  /** The view's base filter for this parameter, in place of the view's `filter`. */
  filter?: RecordsFilterGroup
  /** Per tab key: the tab's filter and definition for this parameter, in place of the tab's own. */
  tabs?: Record<string, { filter?: RecordsFilterGroup, definition?: ViewTabDefinition }>
}

export interface ViewsBuiltInView {
  /** [a-z0-9-]; the view's id is `builtin.<key>`. */
  key: string
  name: string
  icon?: string
  recordTypeKey: string
  /** Listing order among built-ins (default 100). */
  order?: number
  /** The view's base filter, given the parameter (null for unparameterized views). */
  filter?: (param: string | null) => RecordsFilterGroup
  /**
   * Makes the view parameterized: opened only as `builtin.<key>.<param>`.
   * `resolve` checks the caller may open it for `param` and names it; null
   * reports the view as missing.
   */
  param?: {
    resolve: (tx: Tx, ctx: TenantContext, param: string) => Promise<ViewsBuiltInTarget | null>
  }
  tabs: ViewsBuiltInTab[]
}

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const PARAM_RE = /^[A-Za-z0-9-]{1,64}$/

const _builtIns = new Map<string, ViewsBuiltInView>()

export function registerBuiltInView(view: ViewsBuiltInView): void {
  if (!KEY_RE.test(view.key)) throw new Error(`Invalid built-in view key "${view.key}"`)
  if (view.tabs.length === 0) throw new Error(`Built-in view "${view.key}" needs a tab`)
  for (const tab of view.tabs) {
    if (!KEY_RE.test(tab.key)) throw new Error(`Invalid tab key "${tab.key}" on built-in view "${view.key}"`)
  }
  _builtIns.set(view.key, view)
}

export function isBuiltInViewId(id: string): boolean {
  return id.startsWith(VIEWS_BUILTIN_PREFIX)
}

/** The id that opens built-in `key`, for `param` when it takes one. */
export function builtInViewId(key: string, param?: string): string {
  return `${VIEWS_BUILTIN_PREFIX}${key}${param ? `.${param}` : ''}`
}

function stableUuid(seed: string): string {
  const hex = createHash('sha256').update(`views:builtin:${seed}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export interface ResolvedBuiltInView {
  /** The id the client uses (`builtin.<key>[.<param>]`). */
  id: string
  def: ViewsBuiltInView
  view: ViewRow
  tabs: ViewTabRow[]
  /** The record a parameterized view stands for, when it names one. */
  recordId: string | null
  /** That record's type. */
  recordType: string | null
  /** The views above it, outermost first. */
  trail: Array<{ id: string, name: string }>
}

const _resolved = new WeakMap<object, ResolvedBuiltInView>()

/** The built-in behind a ViewRow, when it is one. */
export function builtInOf(view: object): ResolvedBuiltInView | undefined {
  return _resolved.get(view)
}

// Whether the caller can open views over the type: it exists, isn't hidden
// in this org, and the caller may read it.
async function typeOpenTo(tx: Tx, ctx: TenantContext, typeKey: string): Promise<boolean> {
  const type = await getRecordType(tx, typeKey)
  if (!type || type.orphan || type.hidden) return false
  return await resolveTypePermission(tx, ctx, typeKey, 'read')
}

function build(id: string, def: ViewsBuiltInView, target: ViewsBuiltInTarget, param: string | null): ResolvedBuiltInView {
  const name = target.name
  const viewUuid = stableUuid(id)
  const definition: ViewDefinition = {}
  const filter = target.filter ?? def.filter?.(param)
  if (filter && filter.rules.length > 0) definition.filter = filter
  const epoch = new Date(0)
  const positions = generateNKeysBetween(null, null, def.tabs.length)
  const view: ViewRow = {
    id: viewUuid,
    name,
    icon: def.icon ?? null,
    record_type_key: target.recordTypeKey ?? def.recordTypeKey,
    visibility: 'private',
    org_level: null,
    owner_id: viewUuid,
    definition: definition as Record<string, unknown>,
    created_at: epoch,
    updated_at: epoch
  }
  const tabs: ViewTabRow[] = def.tabs.map((tab, i) => {
    const own = target.tabs?.[tab.key]
    const tabFilter = own?.filter ?? tab.filter?.(param)
    const tabDefinition = own?.definition ?? tab.definition
    return {
      id: stableUuid(`${def.key}#${tab.key}`),
      view_id: viewUuid,
      name: tab.name,
      layout: tab.layout,
      position: positions[i]!,
      definition: (tabFilter ? { ...tabDefinition, filter: tabFilter } : tabDefinition) as Record<string, unknown>,
      created_at: epoch,
      updated_at: epoch
    }
  })
  const resolved: ResolvedBuiltInView = {
    id,
    def,
    view,
    tabs,
    recordId: target.recordId ?? null,
    recordType: target.recordId ? target.recordType ?? target.recordTypeKey ?? def.recordTypeKey : null,
    trail: (target.trail ?? []).map(t => ({ id: builtInViewId(def.key, t.param), name: t.name }))
  }
  _resolved.set(view, resolved)
  return resolved
}

/**
 * The built-in view `id` as the caller may open it, or null when there's no
 * such view or the caller can't open it (existence isn't disclosed).
 */
export async function resolveBuiltInView(tx: Tx, ctx: TenantContext, id: string): Promise<ResolvedBuiltInView | null> {
  if (!isBuiltInViewId(id)) return null
  const rest = id.slice(VIEWS_BUILTIN_PREFIX.length)
  const dot = rest.indexOf('.')
  const key = dot === -1 ? rest : rest.slice(0, dot)
  const param = dot === -1 ? null : rest.slice(dot + 1)
  const def = _builtIns.get(key)
  if (!def) return null
  if (!!def.param !== (param !== null)) return null
  if (param !== null && !PARAM_RE.test(param)) return null
  let target: ViewsBuiltInTarget = { name: def.name }
  if (def.param && param !== null) {
    const named = await def.param.resolve(tx, ctx, param)
    if (!named) return null
    target = named
  }
  if (!(await typeOpenTo(tx, ctx, target.recordTypeKey ?? def.recordTypeKey))) return null
  return build(id, def, target, param)
}

/** The unparameterized built-ins the caller can open, in listing order. */
export async function listBuiltInViews(tx: Tx, ctx: TenantContext): Promise<ResolvedBuiltInView[]> {
  const defs = [..._builtIns.values()]
    .filter(d => !d.param)
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.name.localeCompare(b.name))
  const out: ResolvedBuiltInView[] = []
  for (const def of defs) {
    if (await typeOpenTo(tx, ctx, def.recordTypeKey)) out.push(build(builtInViewId(def.key), def, { name: def.name }, null))
  }
  return out
}

export function __resetBuiltInViewsForTests(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('__resetBuiltInViewsForTests is not callable in production')
  }
  _builtIns.clear()
}
