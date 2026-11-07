// Shared records manifest types — the code-owned definition layer for record
// types and their fields, imported by both server and client via the
// `#records` alias. One field-kind registry drives storage routing,
// validation, rendering, and filtering, so adding a kind is a change in
// exactly one vocabulary.
//
// The vocabulary names the communication_channel kind and its `channels`
// storage, but the kernel holds no channel behavior: the layer that owns
// channels (crm) registers a storage driver for them (server) and a field
// widget (client). Without that layer the kind is not offered.

import type { Component } from 'vue'

// The records permission set, for layers that register MCP tools under
// records scopes and must make sure those scopes exist first.
export { RECORDS_PERMISSIONS, RECORDS_PERMISSION_META } from './permissions'
// The filter tree's runtime helpers, importable from '#records' in client code.
export {
  isRecordsFilterGroup,
  recordsFilterOps,
  recordsFilterRuleCount,
  RECORDS_FILTER_INTRINSIC_KINDS,
  RECORDS_FILTER_MAX_DEPTH,
  RECORDS_FILTER_ME,
  RECORDS_FILTER_OP_LABELS,
  RECORDS_FILTER_VALUE_SHAPE
} from '../../client/filters'

export type RecordsFieldKind =
  | 'text'
  | 'textarea'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'key_select'
  | 'multi_select'
  | 'tags'
  | 'user_select'
  | 'communication_channel'
  | 'connection'
  | 'link'

// Where a field's values physically live:
//   promoted    — a real column on records_entries (name, status)
//   jsonb       — a key in records_entries.data (single-value scalars)
//   entries     — rows in records_field_entries (multi-value kinds)
//   user_refs   — rows in records_user_refs (user references)
//   connections — rows in records_connections (record↔record edges)
//   channels    — a registered storage driver (the crm layer's channel service)
export type RecordsStorage = 'promoted' | 'jsonb' | 'entries' | 'user_refs' | 'connections' | 'channels'

export interface RecordsFieldOption {
  label: string
  color?: string
  description?: string
  /** Soft-removed options stay for historical values but are not offered. */
  deleted?: boolean
  /** Status options only: this status means the record is closed (archived). */
  closed?: boolean
  /**
   * Closed-reason options only, code-declared and read by the crm layer's
   * closing hook: closing with this reason revokes every consent on the
   * record's addresses ("asked to be removed").
   */
  revokesConsent?: boolean
}

export interface RecordsFieldDef {
  kind: RecordsFieldKind
  /** Code-owned default label; admins override via records_fields rows. */
  label: string
  /** Code-owned default icon; admins override via records_fields rows. */
  icon?: string
  description?: string
  /** Section key referencing the manifest's `sections` map. */
  section?: string
  required?: boolean
  default?: unknown
  order?: number
  hidden?: boolean
  /** key_select / multi_select choices; tags may seed a vocabulary. */
  options?: Record<string, RecordsFieldOption>
  /** Presence promotes the field to a real column on records_entries. */
  column?: 'name' | 'status'
  /** user_select: allow multiple users (assigned_to is multi-user). */
  multiple?: boolean
  /** connection: target record-type key. */
  target?: string
  /** connection: field key on the target type used for reverse reads. */
  reverseKey?: string
  /** communication_channel: channel type key ('email', 'phone', ...). */
  channelType?: string
  /** Kind-specific extras with no schema of their own. */
  settings?: Record<string, unknown>
}

/** How a connection field shows on a card. */
export type RecordsCardConnectionDisplay = 'names' | 'count' | 'progress'

/** A card layout: which fields a card or table row shows, in order. */
export interface RecordsCardLayout {
  fields: string[]
  /** Per connection field shown on the card; unlisted ones show names. */
  connections?: Record<string, RecordsCardConnectionDisplay>
}

export interface RecordTypeManifest {
  key: string
  /** Plural display label ('Contacts'). */
  label: string
  labelSingular: string
  icon?: string
  /** Field key of the key_select promoted to the status column. */
  statusField?: string
  /** Field key of the key_select holding why a closed record was closed. */
  closedReasonField?: string
  /** Code-owned sections; RecordsFieldDef.section references these keys. */
  sections?: Record<string, { label: string, order?: number }>
  fields: Record<string, RecordsFieldDef>
  /**
   * Permission-slug namespace for this type's actions (`<prefix>.<action>`).
   * Defaults to the generic `records.entries` set every runtime type shares.
   */
  permissionPrefix?: string
  /**
   * The app whose per-org switch gates this type's records (contacts → crm).
   * Types without one are reachable wherever the records layer is loaded.
   */
  app?: string
  /**
   * Whether putting a record on a shared board makes it visible to the
   * board's viewers. Defaults to true; types holding personal data opt out.
   */
  boardsGrantVisibility?: boolean
  /** Default card layout boards and tables over this type start from. */
  card?: RecordsCardLayout
}

/** Identity helper that preserves literal types (option keys stay literal). */
export function defineRecordType<const M extends RecordTypeManifest>(manifest: M): M {
  return manifest
}

export function storageOf(def: Pick<RecordsFieldDef, 'kind' | 'column'>): RecordsStorage {
  if (def.column) return 'promoted'
  switch (def.kind) {
    case 'multi_select':
    case 'tags':
    case 'link':
      return 'entries'
    case 'user_select':
      return 'user_refs'
    case 'connection':
      return 'connections'
    case 'communication_channel':
      return 'channels'
    default:
      return 'jsonb'
  }
}

// ---------------------------------------------------------------------------
// Hydrated value shapes
// ---------------------------------------------------------------------------

export interface RecordsLinkValue {
  url: string
  label?: string
}

/** A connection edge as it appears on a hydrated record — id plus the
 * target record's display name, resolved server-side in one batched query. */
export interface RecordsConnectedRecord {
  id: string
  name: string
  /** The caller can't open the linked record: its name is withheld (''). */
  hidden?: true
}

type FieldValue<F extends RecordsFieldDef> =
  F['kind'] extends 'text' | 'textarea' ? string | null
    : F['kind'] extends 'number' ? number | null
      : F['kind'] extends 'boolean' ? boolean | null
        : F['kind'] extends 'date' | 'datetime' ? string | null
          : F['kind'] extends 'key_select'
            ? (F['options'] extends Record<string, RecordsFieldOption> ? Extract<keyof F['options'], string> | null : string | null)
            : F['kind'] extends 'multi_select' | 'tags' ? string[]
              : F['kind'] extends 'user_select'
                ? (F['multiple'] extends true ? string[] : string | null)
                : F['kind'] extends 'connection' ? RecordsConnectedRecord[]
                  // Shaped by the layer that registers the channel storage driver.
                  : F['kind'] extends 'communication_channel' ? unknown[]
                    : F['kind'] extends 'link' ? RecordsLinkValue[]
                      : unknown

/** Logical (post-hydration) record shape derived from a manifest. */
export type InferRecordShape<M extends RecordTypeManifest> = {
  [K in keyof M['fields']]: FieldValue<M['fields'][K]>
}

// Open registry: each layer that registers a record type widens this via
// `declare module '#records'`, the same pattern as core's #permissions.
export interface RecordTypeRegistry {}

export type RecordShape<K extends keyof RecordTypeRegistry> = RecordTypeRegistry[K]

// ---------------------------------------------------------------------------
// Client-side extension registries
// ---------------------------------------------------------------------------
// Core's registries are server-side and can't carry Vue components, so the
// records UI exposes these small client registries for OTHER layers. Each
// is optional both ways: the UI works with nothing registered, and a layer
// that registers depends on records, never the reverse. Registering layers
// call these from a Nuxt app plugin. A repeat registration with the same id
// replaces the earlier one (HMR-safe). Registration happens at app-plugin
// init, before any record page renders, so readers' results are stable.

function upsert<T extends { id: string }>(list: T[], entry: T): void {
  const i = list.findIndex(e => e.id === entry.id)
  if (i >= 0) list[i] = entry
  else list.push(entry)
}

function forType<T extends { recordTypes?: string[], order?: number }>(list: T[], recordType: string): T[] {
  return list
    .filter(p => !p.recordTypes?.length || p.recordTypes.includes(recordType))
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
}

/** A panel on the record detail page, after the field sections. */
export interface RecordsDetailPanel {
  id: string
  /** Record-type keys this panel renders for; omit/empty = every type. */
  recordTypes?: string[]
  /** Receives `recordId` + `recordType` props. */
  component: Component
  /** Ascending render order among panels (default 100). */
  order?: number
}

const _detailPanels: RecordsDetailPanel[] = []

export function registerRecordsDetailPanel(panel: RecordsDetailPanel): void {
  upsert(_detailPanels, panel)
}

export function getRecordsDetailPanels(recordType: string): RecordsDetailPanel[] {
  return forType(_detailPanels, recordType)
}

/**
 * Replaces the plain field row for one kind on the detail page. Receives
 * `field`, `value`, `record` and `editable` props, and emits `refresh` after
 * changing the record through its own routes.
 */
export interface RecordsFieldWidget {
  id: string
  kind: RecordsFieldKind
  component: Component
}

const _fieldWidgets: RecordsFieldWidget[] = []

export function registerRecordsFieldWidget(widget: RecordsFieldWidget): void {
  upsert(_fieldWidgets, widget)
}

export function getRecordsFieldWidget(kind: string): RecordsFieldWidget | undefined {
  return _fieldWidgets.find(w => w.kind === kind)
}

/**
 * Extra inputs the schema builder shows when creating a field of one kind.
 * The component takes `v-model` over the kind's extra create-body keys
 * (e.g. `{ channelType }`) and a `readonly` prop for the edit view.
 */
export interface RecordsFieldKindSettings {
  id: string
  kind: RecordsFieldKind
  component: Component
  /** True once the extra keys hold everything a create needs. */
  isComplete?: (value: Record<string, unknown>) => boolean
}

const _kindSettings: RecordsFieldKindSettings[] = []

export function registerRecordsFieldKindSettings(entry: RecordsFieldKindSettings): void {
  upsert(_kindSettings, entry)
}

export function getRecordsFieldKindSettings(kind: string): RecordsFieldKindSettings | undefined {
  return _kindSettings.find(s => s.kind === kind)
}

/** A section on the records settings page, after the record-type list. */
export interface RecordsSettingsSection {
  id: string
  title: string
  component: Component
  order?: number
}

const _settingsSections: RecordsSettingsSection[] = []

export function registerRecordsSettingsSection(section: RecordsSettingsSection): void {
  upsert(_settingsSections, section)
}

export function getRecordsSettingsSections(): RecordsSettingsSection[] {
  return [..._settingsSections].sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
}

/**
 * Where a type's records live in the UI, as an app-local path ('/crm' for
 * contacts). Types without one live under the records app.
 */
export interface RecordsTypeRoute {
  id: string
  recordType: string
  /** App path with no org prefix, e.g. '/crm'. Detail pages are `<base>/<id>`. */
  base: string
}

const _typeRoutes: RecordsTypeRoute[] = []

export function registerRecordsTypeRoute(route: RecordsTypeRoute): void {
  upsert(_typeRoutes, route)
}

export function getRecordsTypeRoute(recordType: string): RecordsTypeRoute | undefined {
  return _typeRoutes.find(r => r.recordType === recordType)
}
