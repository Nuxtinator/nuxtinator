// Merged record definitions — code manifests/registrations ⊳ DB override rows.
// Built on core's `defineSettings` (see CLAUDE.md → "Settings pattern"): code
// is the source of truth for what exists, the DB stores only explicit
// customizations. Orphan rows are load-bearing here, not admin sugar — an
// admin-created record type is a records_types row with `is_custom` and no
// code manifest, and an admin-created field is a records_fields row with
// `kind` set — so every reader runs with orphans included.
//
// No cross-request caching: rows are org-scoped by RLS through the caller's
// tenant transaction, so a cached merge would leak one org's schema into
// another's requests. Every call re-reads.

import type { Selectable } from 'kysely'
import { defineSettings, type DbClient } from '#core/server/utils/settings'
import type { Database } from '#core/server/database/schema'
import { RECORDS_REMINDER_FIELD, RECORDS_REMINDER_KEY, RECORDS_REPEAT_FIELD, RECORDS_REPEAT_KEY, storageOf } from '#records'
import type {
  RecordsCardConnectionDisplay,
  RecordsCardLayout,
  RecordsFieldDef,
  RecordsFieldKind,
  RecordsFieldOption,
  RecordTypeManifest,
  RecordsStorage
} from '#records'
import { getRegisteredRecordTypes, getRegisteredRecordType } from './records-registry'
import type { RecordsTypeRoleGrants, RecordsTypeTeamGrants } from './records-perms'

type RecordTypeRow = Selectable<Database['records_types']>
type RecordFieldRow = Selectable<Database['records_fields']>

// --- Record types ----------------------------------------------------------

export interface RecordTypeSetting {
  key: string
  label: string
  labelSingular: string
  icon?: string
  statusField?: string
  /** Closed-reason field: config.closedReasonField ⊳ the manifest's. */
  closedReasonField?: string
  /** Due-date field: config.dueField ⊳ the manifest's. */
  dueField?: string
  sections: Record<string, { label: string, order?: number }>
  hidden: boolean
  config: Record<string, unknown>
  /**
   * Per-role action grants from config.roleGrants — empty when absent. A
   * code-declared type needs an override row to carry grants; that is the
   * expected storage shape (grants are org data, never code defaults).
   */
  roleGrants: RecordsTypeRoleGrants
  /** Per-team action grants from config.teamGrants (group id → actions); empty when absent. */
  teamGrants: RecordsTypeTeamGrants
  /** True for admin-created types (an is_custom row with no code manifest). */
  custom: boolean
  /** True for stale rows: no code manifest and not admin-created either. */
  orphan: boolean
  /** The code manifest, present only for code-declared types. */
  manifest?: RecordTypeManifest
  /** Slug namespace for this type's actions: the manifest's, else `records.entries`. */
  permissionPrefix: string
  /**
   * Whether a record on a shared board becomes visible to the board's
   * viewers: config.boardsGrantVisibility ⊳ the manifest's ⊳ true.
   */
  boardsGrantVisibility: boolean
  /** Default card layout: config.card ⊳ the manifest's ⊳ none. */
  card: RecordsCardLayout | null
}

export const RECORDS_DEFAULT_PERMISSION_PREFIX = 'records.entries'

const CONNECTION_DISPLAYS = new Set<RecordsCardConnectionDisplay>(['names', 'count', 'progress'])

// config.card, shape-checked: a list of field keys plus optional per-field
// connection displays and a cover field. Anything else reads as "not set".
function cardOf(config: Record<string, unknown> | undefined, fallback: RecordsCardLayout | undefined): RecordsCardLayout | null {
  const raw = config?.card
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const fields = (raw as { fields?: unknown }).fields
    if (Array.isArray(fields) && fields.every(f => typeof f === 'string')) {
      const connections: Record<string, RecordsCardConnectionDisplay> = {}
      const rawConnections = (raw as { connections?: unknown }).connections
      if (rawConnections && typeof rawConnections === 'object') {
        for (const [key, value] of Object.entries(rawConnections)) {
          if (CONNECTION_DISPLAYS.has(value as RecordsCardConnectionDisplay)) {
            connections[key] = value as RecordsCardConnectionDisplay
          }
        }
      }
      const cover = (raw as { cover?: unknown }).cover
      return typeof cover === 'string' && cover !== ''
        ? { fields: fields as string[], connections, cover }
        : { fields: fields as string[], connections }
    }
  }
  return fallback ?? null
}

function boardsGrantVisibilityOf(config: Record<string, unknown> | undefined, fallback: boolean | undefined): boolean {
  if (typeof config?.boardsGrantVisibility === 'boolean') return config.boardsGrantVisibility
  return fallback ?? true
}

// The config.roleGrants slice, shape-checked — anything that isn't a plain
// object reads as "no grants" rather than corrupting the evaluator.
function roleGrantsOf(config: Record<string, unknown> | undefined): RecordsTypeRoleGrants {
  const raw = config?.roleGrants
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as RecordsTypeRoleGrants
  return {}
}

function teamGrantsOf(config: Record<string, unknown> | undefined): RecordsTypeTeamGrants {
  const raw = config?.teamGrants
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as RecordsTypeTeamGrants
  return {}
}

// config.closedReasonField: a field key picked in the schema builder, or
// null to drop the code-declared one. Absent means the manifest's.
function closedReasonFieldOf(config: Record<string, unknown> | undefined, fallback: string | undefined): string | undefined {
  if (!config || !('closedReasonField' in config)) return fallback
  const raw = config.closedReasonField
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

// config.dueField: a date field picked in the schema builder, or null to drop
// the code-declared one. Absent means the manifest's.
function dueFieldOf(config: Record<string, unknown> | undefined, fallback: string | undefined): string | undefined {
  if (!config || !('dueField' in config)) return fallback
  const raw = config.dueField
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

export const getRecordTypes = defineSettings<RecordTypeManifest, RecordTypeRow, RecordTypeSetting>({
  loadDefaults: () => getRegisteredRecordTypes(),
  loadOverrides: async (tx) => {
    const rows = await tx.selectFrom('records_types').selectAll().execute()
    return new Map(rows.map(r => [r.type_key, r]))
  },
  keyOf: m => m.key,
  merge: (manifest, row) => {
    if (manifest) {
      return {
        key: manifest.key,
        label: row?.label_override ?? manifest.label,
        labelSingular: row?.label_singular_override ?? manifest.labelSingular,
        icon: row?.icon_override ?? manifest.icon,
        statusField: manifest.statusField ?? statusFieldKeyOf(recordTypeCodeFields(manifest)),
        closedReasonField: closedReasonFieldOf(row?.config, manifest.closedReasonField),
        dueField: dueFieldOf(row?.config, manifest.dueField),
        sections: manifest.sections ?? {},
        hidden: row?.hidden ?? false,
        config: row?.config ?? {},
        roleGrants: roleGrantsOf(row?.config),
        teamGrants: teamGrantsOf(row?.config),
        custom: false,
        orphan: false,
        manifest,
        permissionPrefix: manifest.permissionPrefix ?? RECORDS_DEFAULT_PERMISSION_PREFIX,
        boardsGrantVisibility: boardsGrantVisibilityOf(row?.config, manifest.boardsGrantVisibility),
        card: cardOf(row?.config, manifest.card)
      }
    }
    // Orphan branch — row is guaranteed defined (defineSettings only calls
    // merge(undefined, …) for orphans).
    const r = row!
    return {
      key: r.type_key,
      label: r.label_override ?? r.type_key,
      labelSingular: r.label_singular_override ?? r.label_override ?? r.type_key,
      icon: r.icon_override ?? undefined,
      statusField: r.is_custom ? statusFieldKeyOf(recordTypeCodeFields(undefined)) : undefined,
      closedReasonField: r.is_custom ? closedReasonFieldOf(r.config, undefined) : undefined,
      dueField: r.is_custom ? dueFieldOf(r.config, undefined) : undefined,
      sections: {},
      hidden: r.hidden,
      config: r.config,
      roleGrants: roleGrantsOf(r.config),
      teamGrants: teamGrantsOf(r.config),
      custom: r.is_custom,
      orphan: !r.is_custom,
      permissionPrefix: RECORDS_DEFAULT_PERMISSION_PREFIX,
      boardsGrantVisibility: boardsGrantVisibilityOf(r.config, undefined),
      card: cardOf(r.config, undefined)
    }
  },
  includeOrphans: true
})

export async function getRecordType(tx: DbClient, typeKey: string): Promise<RecordTypeSetting | null> {
  const all = await getRecordTypes(tx)
  return all.find(t => t.key === typeKey) ?? null
}

// --- Fields ----------------------------------------------------------------

export interface RecordsFieldSetting {
  key: string
  kind: RecordsFieldKind
  storage: RecordsStorage
  column?: 'name' | 'status'
  label: string
  icon?: string
  description?: string
  section?: string
  required: boolean
  hidden: boolean
  order: number
  default?: unknown
  /** Merged options: manifest options ⊳ config overrides + custom options. */
  options?: Record<string, RecordsFieldOption>
  multiple?: boolean
  /** user_select: naming someone lets them see the record (code-declared only). */
  grantsAccess?: boolean
  target?: string
  reverseKey?: string
  /** connection: the parent or children side of a hierarchy the type takes part in. */
  hierarchy?: 'parent' | 'children'
  channelType?: string
  /** ref: the registered ref source (code-declared only). */
  source?: string
  settings?: Record<string, unknown>
  /** The type's due-date field (see RecordTypeSetting.dueField). */
  due?: boolean
  /** True for admin-created custom fields (a row with `kind` set). */
  custom: boolean
  /** True for stale rows: no manifest field and no `kind` either. */
  orphan: boolean
}

// The slice of records_fields.config the merge understands:
//   { options?: Record<optionKey, Partial<RecordsFieldOption>>, optionOrder?: string[] }
// Keys matching a manifest option override just the given props; keys the
// manifest doesn't declare are admin-added custom options. optionOrder lists
// option keys in display order; options it doesn't name follow in merge order.
export function mergeOptions(
  base: Record<string, RecordsFieldOption> | undefined,
  config: Record<string, unknown> | undefined
): Record<string, RecordsFieldOption> | undefined {
  const overrides = config?.options as Record<string, Partial<RecordsFieldOption>> | undefined
  if (!base && !overrides) return undefined
  const merged: Record<string, RecordsFieldOption> = {}
  for (const [key, option] of Object.entries(base ?? {})) merged[key] = { ...option }
  for (const [key, override] of Object.entries(overrides ?? {})) {
    merged[key] = { ...(merged[key] ?? { label: key }), ...override }
  }
  const order = Array.isArray(config?.optionOrder) ? config.optionOrder : []
  const out: Record<string, RecordsFieldOption> = {}
  for (const key of order) {
    if (typeof key === 'string' && merged[key]) out[key] = merged[key]
  }
  for (const [key, option] of Object.entries(merged)) {
    if (!out[key]) out[key] = option
  }
  return out
}

// A status whose default option was removed or made closed starts new
// records (and reads unset ones) in its first open option instead.
function statusDefaultOf(def: RecordsFieldDef, options: Record<string, RecordsFieldOption> | undefined): unknown {
  if (def.column !== 'status' || !options) return def.default
  const current = typeof def.default === 'string' ? options[def.default] : undefined
  if (current && !current.deleted && !current.closed) return def.default
  return Object.entries(options).find(([, o]) => !o.deleted && !o.closed)?.[0] ?? def.default
}

function mergeManifestField(key: string, def: RecordsFieldDef, row: RecordFieldRow | undefined): RecordsFieldSetting {
  const options = mergeOptions(def.options, row?.config)
  return {
    key,
    kind: def.kind,
    storage: storageOf(def),
    column: def.column,
    label: row?.label_override ?? def.label,
    icon: row?.icon_override ?? def.icon,
    description: def.description,
    section: row?.section_override ?? def.section,
    required: row?.required_override ?? def.required ?? false,
    // `hidden` is NOT NULL on the row, so it can't express "no override" —
    // when a row exists its value is authoritative (the schema builder
    // writes the desired state). The status field is always shown.
    hidden: def.column === 'status' ? false : row ? row.hidden : (def.hidden ?? false),
    order: row?.order_override ?? def.order ?? 0,
    default: statusDefaultOf(def, options),
    options,
    multiple: def.multiple,
    grantsAccess: def.kind === 'user_select' && def.grantsAccess === true ? true : undefined,
    target: def.target,
    reverseKey: def.reverseKey,
    hierarchy: def.kind === 'connection' ? def.hierarchy : undefined,
    channelType: def.channelType,
    source: def.kind === 'ref' ? def.source : undefined,
    settings: def.settings,
    custom: false,
    orphan: false
  }
}

function mergeOrphanField(row: RecordFieldRow): RecordsFieldSetting {
  const custom = row.kind !== null
  const kind = (row.kind ?? 'text') as RecordsFieldKind
  // Custom fields never promote to record columns and can't join the
  // user_refs storage class (it carries code-owned semantics), so storage is
  // clamped to entries or jsonb — except connection, whose target type is
  // kept in config and whose edges are forward-only unless it is one side of
  // a hierarchy pair (config.hierarchy with config.reverseKey), attachments, whose files
  // live in their own table, and communication_channel, whose one definition
  // input (the channel type, kept in config by the schema builder) is
  // admin-suppliable, so it routes to the channel storage driver like a
  // manifest channel field.
  const natural = storageOf({ kind })
  const storage = natural === 'channels' || natural === 'entries' || natural === 'connections' || natural === 'attachments' ? natural : 'jsonb'
  return {
    key: row.field_key,
    kind,
    storage,
    label: row.label_override ?? row.field_key,
    icon: row.icon_override ?? undefined,
    section: row.section_override ?? undefined,
    required: row.required_override ?? false,
    hidden: row.hidden,
    order: row.order_override ?? 0,
    options: mergeOptions(undefined, row.config),
    channelType: typeof row.config.channelType === 'string' ? row.config.channelType : undefined,
    target: typeof row.config.target === 'string' ? row.config.target : undefined,
    ...(kind === 'connection' ? customHierarchyOf(row.config) : {}),
    multiple: kind === 'connection' ? true : undefined,
    custom,
    orphan: !custom
  }
}

// A custom connection's side of a hierarchy pair: config.hierarchy, with the
// key of its pair on the target type in config.reverseKey.
function customHierarchyOf(config: Record<string, unknown>): Pick<RecordsFieldSetting, 'hierarchy' | 'reverseKey'> {
  const side = config.hierarchy
  const reverseKey = config.reverseKey
  if ((side !== 'parent' && side !== 'children') || typeof reverseKey !== 'string' || reverseKey === '') return {}
  return { hierarchy: side, reverseKey }
}

// The name column is intrinsic to every record type — the create pipeline
// and the list engine resolve it through a field def with column: 'name'.
// Code manifests declare their own; types without a manifest (admin-created
// customs) get this synthesized def, which behaves like a code default:
// overridable via a records_fields row but never deletable.
export const RECORDS_INTRINSIC_NAME_FIELD: RecordsFieldDef = {
  kind: 'text',
  label: 'Name',
  column: 'name',
  required: true,
  order: 0
}

// Every record type has a status, so every record can be closed. A type
// whose code declares no status column gets this one; like the name field it
// is a code default, customized through records_fields override rows.
export const RECORDS_DEFAULT_STATUS_FIELD: RecordsFieldDef = {
  kind: 'key_select',
  label: 'Status',
  column: 'status',
  order: 1,
  default: 'open',
  options: {
    open: { label: 'Open', color: 'info' },
    done: { label: 'Done', color: 'success', closed: true }
  }
}

/**
 * The code-owned field defs of a type: its manifest's fields (extensions
 * included), or the intrinsic name field for a type without a manifest, plus
 * the default status field when none of them is the status column, and the
 * reminder and repeat fields unless it declares its own (they show only on a
 * type with a due date; see getRecordTypeFields).
 */
export function recordTypeCodeFields(manifest: RecordTypeManifest | undefined): Record<string, RecordsFieldDef> {
  const fields: Record<string, RecordsFieldDef> = manifest ? { ...manifest.fields } : { name: RECORDS_INTRINSIC_NAME_FIELD }
  const hasStatus = Object.values(fields).some(def => def.column === 'status')
  if (!hasStatus && !('status' in fields)) fields.status = RECORDS_DEFAULT_STATUS_FIELD
  if (!(RECORDS_REMINDER_KEY in fields)) fields[RECORDS_REMINDER_KEY] = RECORDS_REMINDER_FIELD
  if (!(RECORDS_REPEAT_KEY in fields)) fields[RECORDS_REPEAT_KEY] = RECORDS_REPEAT_FIELD
  return fields
}

function statusFieldKeyOf(fields: Record<string, RecordsFieldDef>): string | undefined {
  return Object.entries(fields).find(([, def]) => def.column === 'status')?.[0]
}

export async function getRecordTypeFields(tx: DbClient, typeKey: string): Promise<RecordsFieldSetting[]> {
  const reader = defineSettings<{ key: string, def: RecordsFieldDef }, RecordFieldRow, RecordsFieldSetting>({
    loadDefaults: () => Object.entries(recordTypeCodeFields(getRegisteredRecordType(typeKey)))
      .map(([key, def]) => ({ key, def })),
    loadOverrides: async (tx) => {
      const rows = await tx
        .selectFrom('records_fields')
        .selectAll()
        .where('type_key', '=', typeKey)
        .execute()
      return new Map(rows.map(r => [r.field_key, r]))
    },
    keyOf: d => d.key,
    merge: (d, row) => (d ? mergeManifestField(d.key, d.def, row) : mergeOrphanField(row!)),
    includeOrphans: true
  })
  const fields = await reader(tx)
  // Repeat and reminder count from the due date: they exist on no other type.
  const row = await tx.selectFrom('records_types').select('config').where('type_key', '=', typeKey).executeTakeFirst()
  const dueKey = dueFieldOf(row?.config, getRegisteredRecordType(typeKey)?.dueField)
  const due = dueKey ? fields.find(f => f.key === dueKey && !f.orphan && (f.kind === 'date' || f.kind === 'datetime')) : undefined
  if (due) due.due = true
  return fields
    .filter(f => due || (f.key !== RECORDS_REPEAT_KEY && f.key !== RECORDS_REMINDER_KEY))
    .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
}

/**
 * Keys of the type's people fields that let the people they name see the
 * record. The flag is code-only (admins can't create people fields or change
 * it), so this reads the registry, never the database.
 */
export function recordsAccessGrantingKeys(typeKey: string): string[] {
  return Object.entries(recordTypeCodeFields(getRegisteredRecordType(typeKey)))
    .filter(([, def]) => def.kind === 'user_select' && def.grantsAccess === true && !def.column)
    .map(([key]) => key)
}

/**
 * The fields that place a type's records in trees. A record has one parent,
 * named by one of `parents`; `children` name what sits under a record. A
 * parent may be of another type (a task under a deliverable).
 */
export interface RecordsHierarchy {
  /** Fields naming a record's parent, each with the parent's type. */
  parents: Array<{ key: string, target: string }>
  /** Fields naming what sits under a record: the children's type, and the field on them that names this record. */
  children: Array<{ key: string, target: string, parentKey: string }>
}

/** The hierarchy among `defs` (one type's merged fields), or null for a flat type. */
export function recordsHierarchyOf(defs: RecordsFieldSetting[]): RecordsHierarchy | null {
  const parents: RecordsHierarchy['parents'] = []
  const children: RecordsHierarchy['children'] = []
  for (const def of defs) {
    if (def.orphan || def.kind !== 'connection' || !def.target) continue
    if (def.hierarchy === 'parent') parents.push({ key: def.key, target: def.target })
    else if (def.hierarchy === 'children' && def.reverseKey) children.push({ key: def.key, target: def.target, parentKey: def.reverseKey })
  }
  return parents.length > 0 || children.length > 0 ? { parents, children } : null
}

/** The type's hierarchy, or null for a flat type. An org can add to it, so this reads the type's fields. */
export async function getRecordsHierarchy(tx: DbClient, typeKey: string): Promise<RecordsHierarchy | null> {
  return recordsHierarchyOf(await getRecordTypeFields(tx, typeKey))
}

/**
 * The types a `typeKey` record's ancestors can be of (its own included when
 * its records nest under each other), following parent fields upward.
 */
export async function recordsAncestorTypes(tx: DbClient, typeKey: string): Promise<string[]> {
  const seen = new Set<string>()
  const queue = [typeKey]
  while (queue.length > 0) {
    const hierarchy = await getRecordsHierarchy(tx, queue.shift()!)
    for (const parent of hierarchy?.parents ?? []) {
      if (seen.has(parent.target)) continue
      seen.add(parent.target)
      queue.push(parent.target)
    }
  }
  return [...seen]
}

// Field keys whose connection rows surface in reverse under `def` of
// `typeKey` records: every code field declared with `target: typeKey,
// reverseKey: def.key`, and the pair of a custom field that names what sits
// under a record (those rows are written from the child). Connection rows store
// only the writing side's field_key, so a key shared by two types pointing at
// different targets would be ambiguous — field keys are expected to be
// distinct across connection vocabularies.
export function recordsConnectionReverseKeys(typeKey: string, def: Pick<RecordsFieldSetting, 'key' | 'custom' | 'reverseKey' | 'hierarchy'>): string[] {
  const sources = new Set<string>()
  for (const manifest of getRegisteredRecordTypes()) {
    for (const [key, field] of Object.entries(manifest.fields)) {
      if (field.kind === 'connection' && field.target === typeKey && field.reverseKey === def.key) {
        sources.add(key)
      }
    }
  }
  if (def.custom && def.reverseKey && def.hierarchy !== 'parent') sources.add(def.reverseKey)
  return [...sources]
}

/** The status an unset status column reads as: the status field's default. */
export function recordsStatusDefault(defs: RecordsFieldSetting[]): string | null {
  const value = defs.find(d => d.column === 'status')?.default
  return typeof value === 'string' ? value : null
}
