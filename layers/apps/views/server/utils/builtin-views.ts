// Built-in views: views declared in code (by this layer or another one)
// instead of stored as rows. Everyone who can read the view's record type
// opens them; nobody can change them, so they're opened at 'view' — cards
// still move between field-grouped columns and get added through the
// records routes, and "Copy view" turns one into a view of your own.
//
// A built-in may take a parameter (a meeting's id), which its filter uses.
// Parameterized built-ins aren't listed; another layer opens them for one
// value, e.g. embedded on that meeting's page.
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
    resolve: (tx: Tx, ctx: TenantContext, param: string) => Promise<{ name: string } | null>
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

function build(id: string, def: ViewsBuiltInView, name: string, param: string | null): ResolvedBuiltInView {
  const viewUuid = stableUuid(id)
  const definition: ViewDefinition = {}
  const filter = def.filter?.(param)
  if (filter && filter.rules.length > 0) definition.filter = filter
  const epoch = new Date(0)
  const positions = generateNKeysBetween(null, null, def.tabs.length)
  const view: ViewRow = {
    id: viewUuid,
    name,
    icon: def.icon ?? null,
    record_type_key: def.recordTypeKey,
    visibility: 'private',
    org_level: null,
    owner_id: viewUuid,
    definition: definition as Record<string, unknown>,
    created_at: epoch,
    updated_at: epoch
  }
  const tabs: ViewTabRow[] = def.tabs.map((tab, i) => ({
    id: stableUuid(`${def.key}#${tab.key}`),
    view_id: viewUuid,
    name: tab.name,
    layout: tab.layout,
    position: positions[i]!,
    definition: tab.definition as Record<string, unknown>,
    created_at: epoch,
    updated_at: epoch
  }))
  const resolved: ResolvedBuiltInView = { id, def, view, tabs }
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
  if (!(await typeOpenTo(tx, ctx, def.recordTypeKey))) return null
  let name = def.name
  if (def.param && param !== null) {
    const named = await def.param.resolve(tx, ctx, param)
    if (!named) return null
    name = named.name
  }
  return build(id, def, name, param)
}

/** The unparameterized built-ins the caller can open, in listing order. */
export async function listBuiltInViews(tx: Tx, ctx: TenantContext): Promise<ResolvedBuiltInView[]> {
  const defs = [..._builtIns.values()]
    .filter(d => !d.param)
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.name.localeCompare(b.name))
  const out: ResolvedBuiltInView[] = []
  for (const def of defs) {
    if (await typeOpenTo(tx, ctx, def.recordTypeKey)) out.push(build(builtInViewId(def.key), def, def.name, null))
  }
  return out
}

export function __resetBuiltInViewsForTests(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('__resetBuiltInViewsForTests is not callable in production')
  }
  _builtIns.clear()
}
