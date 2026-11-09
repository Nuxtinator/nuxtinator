// In-process records registries — the code-owned side of every merged
// definition read, plus the extension points other layers plug behavior into.
// Same idiom as core's permissions registry: module-level maps fed by each
// layer's Nitro plugin at boot; registering the same key again overwrites,
// so repeated plugin runs stay idempotent.

import type { Expression, ExpressionBuilder, SqlBool, Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { RecordTypeManifest, RecordsFieldDef, RecordsFieldKind, RecordsFieldOption } from '#records'
import type { TenantContext } from '#tenant/server'
import type { RecordsFieldSetting } from './definition-settings'

type Tx = Transaction<Database>
type Eb = ExpressionBuilder<Database, 'records_entries'>

// --- Record types ----------------------------------------------------------

const _recordTypes = new Map<string, RecordTypeManifest>()

// Fields other layers add to a type they don't own (meetings adds a meeting
// link to tasks). Merged into the type's manifest on every read.
const _fieldExtensions = new Map<string, Map<string, Record<string, RecordsFieldDef>>>()

export function registerRecordType(manifest: RecordTypeManifest): void {
  _recordTypes.set(manifest.key, manifest)
}

/**
 * Adds fields to a registered type from another layer. `owner` identifies
 * the extending layer so a repeat registration replaces its own fields.
 * Extension keys must not collide with the type's own fields.
 */
export function registerRecordFieldExtension(
  typeKey: string,
  owner: string,
  fields: Record<string, RecordsFieldDef>
): void {
  let byOwner = _fieldExtensions.get(typeKey)
  if (!byOwner) {
    byOwner = new Map()
    _fieldExtensions.set(typeKey, byOwner)
  }
  byOwner.set(owner, fields)
}

function withExtensions(manifest: RecordTypeManifest): RecordTypeManifest {
  const byOwner = _fieldExtensions.get(manifest.key)
  if (!byOwner || byOwner.size === 0) return manifest
  const fields = { ...manifest.fields }
  for (const extra of byOwner.values()) {
    for (const [key, def] of Object.entries(extra)) {
      if (!(key in manifest.fields)) fields[key] = def
    }
  }
  return { ...manifest, fields }
}

export function getRegisteredRecordTypes(): RecordTypeManifest[] {
  return [..._recordTypes.values()].map(withExtensions)
}

export function getRegisteredRecordType(key: string): RecordTypeManifest | undefined {
  const manifest = _recordTypes.get(key)
  return manifest ? withExtensions(manifest) : undefined
}

// --- Field-filter hook chain -----------------------------------------------
//
// The dt_post_create_fields analogue: filters run sequentially inside
// applyFieldPatch before validation. Each filter receives the previous
// filter's output and returns the (possibly rewritten) patch.

export type RecordsFieldPatch = Record<string, unknown>

export type RecordsFieldFilterPhase = 'create' | 'update'

export type RecordsFieldFilter = (
  patch: RecordsFieldPatch,
  ctx: TenantContext,
  typeKey: string
) => RecordsFieldPatch | Promise<RecordsFieldPatch>

const _fieldFilters: Record<RecordsFieldFilterPhase, RecordsFieldFilter[]> = {
  create: [],
  update: []
}

export function registerRecordsFieldFilter(phase: RecordsFieldFilterPhase, fn: RecordsFieldFilter): void {
  if (!_fieldFilters[phase].includes(fn)) _fieldFilters[phase].push(fn)
}

export async function runRecordsFieldFilters(
  phase: RecordsFieldFilterPhase,
  patch: RecordsFieldPatch,
  ctx: TenantContext,
  typeKey: string
): Promise<RecordsFieldPatch> {
  let current = patch
  for (const fn of _fieldFilters[phase]) {
    current = await fn(current, ctx, typeKey)
  }
  return current
}

// --- Storage drivers -------------------------------------------------------
//
// A storage class whose tables belong to another layer. The kernel routes a
// field with that storage through the driver for every read, filter, search
// and write. The crm layer registers the `channels` driver.

/** One item of a multi-value patch, as parsed by the field pipeline. */
export interface RecordsListItem {
  value: unknown
  delete: boolean
  primary?: boolean
  label?: string | null
  linkId?: string
}

export interface RecordsListPatch {
  items: RecordsListItem[]
  /** Replace the whole list with the non-delete items. */
  force: boolean
}

export type RecordsFilterCond =
  | { op: 'eq', value: unknown }
  | { op: 'in', values: Array<string | number | boolean> }
  | { op: 'contains', value: string }
  | { op: 'gte' | 'lte', value: string | number }

export interface RecordsFilterHelpers {
  likePattern: (value: string) => string
  badFilter: (key: string, message: string) => never
}

export interface RecordsStorageDriver {
  storage: 'channels'
  /** Field kinds this driver stores; the schema builder offers only kinds with a driver. */
  kinds: RecordsFieldKind[]
  /** Values per record per field key, for the given fields and records. */
  hydrate: (tx: Tx, defs: RecordsFieldSetting[], recordIds: string[]) => Promise<Map<string, Map<string, unknown[]>>>
  filter: (eb: Eb, def: RecordsFieldSetting, cond: RecordsFilterCond, helpers: RecordsFilterHelpers) => Expression<SqlBool>
  /** Free-text search over the driver's values, ORed with the name match. */
  search?: (eb: Eb, pattern: string) => Expression<SqlBool>
  /** Validates (and may normalize) one patch item; throws a 400 on bad input. */
  validateItem: (def: RecordsFieldSetting, item: RecordsListItem) => void
  /** Writes the list patch. Drivers write their own activity rows. */
  apply: (tx: Tx, ctx: TenantContext, recordId: string, def: RecordsFieldSetting, list: RecordsListPatch) => Promise<void>
  /** Checks the kind-specific definition inputs when the schema builder creates a field. */
  validateFieldDefinition?: (tx: Tx, input: { kind: RecordsFieldKind, channelType?: string }) => Promise<void>
}

const _storageDrivers = new Map<string, RecordsStorageDriver>()

export function registerRecordsStorageDriver(driver: RecordsStorageDriver): void {
  _storageDrivers.set(driver.storage, driver)
}

export function getRecordsStorageDriver(storage: string): RecordsStorageDriver | undefined {
  return _storageDrivers.get(storage)
}

export function getRecordsStorageDrivers(): RecordsStorageDriver[] {
  return [..._storageDrivers.values()]
}

// --- Closing hooks ---------------------------------------------------------
//
// Run inside applyFieldPatch after a record moves into a closed status.

export interface RecordsClosingEvent {
  typeKey: string
  recordId: string
  /** The closed-reason option key, or null when the type has no reason field. */
  reason: string | null
  /** The reason option's merged definition, when there is one. */
  reasonOption: RecordsFieldOption | null
}

export type RecordsClosingHook = (tx: Tx, ctx: TenantContext, event: RecordsClosingEvent) => Promise<void>

const _closingHooks: RecordsClosingHook[] = []

export function registerRecordsClosingHook(fn: RecordsClosingHook): void {
  if (!_closingHooks.includes(fn)) _closingHooks.push(fn)
}

export async function runRecordsClosingHooks(tx: Tx, ctx: TenantContext, event: RecordsClosingEvent): Promise<void> {
  for (const fn of _closingHooks) await fn(tx, ctx, event)
}

// --- Patch guards ----------------------------------------------------------
//
// Run by the record PATCH route (not applyFieldPatch, so host code can still
// write the fields a guard protects). A guard throws to refuse the patch.

export type RecordsPatchGuard = (tx: Tx, args: { typeKey: string, recordId: string, fields: RecordsFieldPatch }) => Promise<void>

const _patchGuards: RecordsPatchGuard[] = []

export function registerRecordsPatchGuard(fn: RecordsPatchGuard): void {
  if (!_patchGuards.includes(fn)) _patchGuards.push(fn)
}

export async function runRecordsPatchGuards(tx: Tx, args: { typeKey: string, recordId: string, fields: RecordsFieldPatch }): Promise<void> {
  for (const fn of _patchGuards) await fn(tx, args)
}

// --- Ref sources -----------------------------------------------------------
//
// What a `ref` field's ids point at: rows another layer owns (a meeting). The
// source turns ids into labels and links for the caller and powers the
// picker; the kernel stores only the id.

/** A ref target as its source resolves it for one caller. */
export interface RecordsRefTarget {
  label: string
  /** App-local path to the target, e.g. `/meetings/<id>`. */
  url?: string
}

export interface RecordsRefSource {
  /** The key ref fields name in `source`. */
  source: string
  /** What one target is called ('Meeting'). */
  label: string
  /**
   * The given ids as the caller sees them: a target for each one they can
   * see, 'hidden' for one that exists but they can't see. Ids left out no
   * longer exist.
   */
  resolve: (tx: Tx, ctx: TenantContext, ids: string[]) => Promise<Map<string, RecordsRefTarget | 'hidden'>>
  /** Targets the caller can see whose label matches `q` (all, for an empty q), at most `limit`. */
  search: (tx: Tx, ctx: TenantContext, q: string, limit: number) => Promise<Array<{ id: string, label: string }>>
}

const _refSources = new Map<string, RecordsRefSource>()

export function registerRecordsRefSource(source: RecordsRefSource): void {
  _refSources.set(source.source, source)
}

export function getRecordsRefSource(source: string): RecordsRefSource | undefined {
  return _refSources.get(source)
}

// --- Visibility sources ----------------------------------------------------
//
// Extra ways a caller without view_all may see a record, ORed into the
// kernel's visibility rule (creator, share, user reference). Applied only to
// types whose `boardsGrantVisibility` is not false. A source can also let a
// caller edit the record (like an edit-level share) and say who it shares the
// record with, for the record's share list.

/** One place a record is shared through, as listed on the record's Share list. */
export interface RecordsShareVia {
  sourceId: string
  /** e.g. the view's name. */
  label: string
  /** App-local path to where the sharing is managed. */
  path: string
  /** Who it reaches and at which level. */
  audience: Array<{ kind: 'user' | 'team' | 'everyone', name: string, level: 'view' | 'edit' }>
}

export interface RecordsVisibilitySource {
  id: string
  predicate: (eb: Eb, args: { userId: string, typeKey: string }) => Expression<SqlBool>
  /** Matches the records this source lets `userId` edit. */
  editPredicate?: (eb: Eb, args: { userId: string, typeKey: string }) => Expression<SqlBool>
  /** The places that share the record, limited to the ones `ctx`'s user can open. */
  describe?: (tx: Tx, ctx: TenantContext, recordId: string) => Promise<RecordsShareVia[]>
}

const _visibilitySources = new Map<string, RecordsVisibilitySource>()

export function registerRecordsVisibilitySource(source: RecordsVisibilitySource): void {
  _visibilitySources.set(source.id, source)
}

export function getRecordsVisibilitySources(): RecordsVisibilitySource[] {
  return [..._visibilitySources.values()]
}

export function __resetRecordsRegistriesForTests(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('__resetRecordsRegistriesForTests is not callable in production')
  }
  _recordTypes.clear()
  _fieldExtensions.clear()
  _fieldFilters.create = []
  _fieldFilters.update = []
  _storageDrivers.clear()
  _closingHooks.length = 0
  _patchGuards.length = 0
  _visibilitySources.clear()
  _refSources.clear()
}
