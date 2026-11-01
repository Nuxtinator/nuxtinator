// Shared CRM manifest types — the code-owned definition layer for record
// types and their fields, imported by both server and client via the `#crm`
// alias. One field-kind registry drives storage routing, validation,
// rendering, and filtering, so adding a kind is a change in exactly one
// vocabulary.

export type CrmFieldKind =
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
//   promoted    — a real column on crm_records (name, status)
//   jsonb       — a key in crm_records.data (single-value scalars)
//   entries     — rows in crm_record_field_entries (multi-value kinds)
//   user_refs   — rows in crm_record_user_refs (user references)
//   connections — rows in crm_record_connections (record↔record edges)
//   channels    — crm_channels + crm_contact_channels via the channel service
export type CrmStorage = 'promoted' | 'jsonb' | 'entries' | 'user_refs' | 'connections' | 'channels'

export interface CrmFieldOption {
  label: string
  color?: string
  description?: string
  /** Soft-removed options stay for historical values but are not offered. */
  deleted?: boolean
  /** Status options only: this status means the record is closed (archived). */
  closed?: boolean
  /**
   * Closed-reason options only, code-declared: closing with this reason
   * revokes every consent on the record's addresses ("asked to be removed").
   */
  revokesConsent?: boolean
}

export interface CrmFieldDef {
  kind: CrmFieldKind
  /** Code-owned default label; admins override via crm_record_fields rows. */
  label: string
  /** Code-owned default icon; admins override via crm_record_fields rows. */
  icon?: string
  description?: string
  /** Section key referencing the manifest's `sections` map. */
  section?: string
  required?: boolean
  default?: unknown
  order?: number
  hidden?: boolean
  /** key_select / multi_select choices; tags may seed a vocabulary. */
  options?: Record<string, CrmFieldOption>
  /** Presence promotes the field to a real column on crm_records. */
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

export interface CrmRecordTypeManifest {
  key: string
  /** Plural display label ('Contacts'). */
  label: string
  labelSingular: string
  icon?: string
  /** Field key of the key_select promoted to the status column. */
  statusField?: string
  /** Field key of the key_select holding why a closed record was closed. */
  closedReasonField?: string
  /** Code-owned sections; CrmFieldDef.section references these keys. */
  sections?: Record<string, { label: string, order?: number }>
  fields: Record<string, CrmFieldDef>
}

/** Identity helper that preserves literal types (option keys stay literal). */
export function defineRecordType<const M extends CrmRecordTypeManifest>(manifest: M): M {
  return manifest
}

export function storageOf(def: Pick<CrmFieldDef, 'kind' | 'column'>): CrmStorage {
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

/** A channel entry as it appears on a hydrated record. */
export interface CrmChannelEntry {
  /** crm_contact_channels row id (the link). */
  linkId: string
  /** crm_channels row id (the shared address entity). */
  channelId: string
  channelType: string
  value: string
  label: string | null
  isPrimary: boolean
  verified: boolean
}

export interface CrmLinkValue {
  url: string
  label?: string
}

/** A connection edge as it appears on a hydrated record — id plus the
 * target record's display name, resolved server-side in one batched query. */
export interface CrmConnectedRecord {
  id: string
  name: string
}

type FieldValue<F extends CrmFieldDef> =
  F['kind'] extends 'text' | 'textarea' ? string | null
    : F['kind'] extends 'number' ? number | null
      : F['kind'] extends 'boolean' ? boolean | null
        : F['kind'] extends 'date' | 'datetime' ? string | null
          : F['kind'] extends 'key_select'
            ? (F['options'] extends Record<string, CrmFieldOption> ? Extract<keyof F['options'], string> | null : string | null)
            : F['kind'] extends 'multi_select' | 'tags' ? string[]
              : F['kind'] extends 'user_select'
                ? (F['multiple'] extends true ? string[] : string | null)
                : F['kind'] extends 'connection' ? CrmConnectedRecord[]
                  : F['kind'] extends 'communication_channel' ? CrmChannelEntry[]
                    : F['kind'] extends 'link' ? CrmLinkValue[]
                      : unknown

/** Logical (post-hydration) record shape derived from a manifest. */
export type InferRecordShape<M extends CrmRecordTypeManifest> = {
  [K in keyof M['fields']]: FieldValue<M['fields'][K]>
}

// Open registry: each layer that registers a record type widens this via
// `declare module '#crm'`, the same pattern as core's #permissions.
export interface CrmRecordTypeRegistry {}

export type CrmRecordShape<K extends keyof CrmRecordTypeRegistry> = CrmRecordTypeRegistry[K]

// ---------------------------------------------------------------------------
// Client-side detail-panel registry
// ---------------------------------------------------------------------------
// Core's six registries are server-side and can't carry Vue components, so
// CRM exposes this small client registry for OTHER layers to inject panels
// onto the record detail page (rendered after the connections panel). Optional
// both ways: CRM renders zero panels when nothing is registered, and a layer
// that registers one (e.g. inbox's conversations panel) depends on CRM, never
// the reverse. A registering layer calls `registerCrmDetailPanel` from a Nuxt
// app plugin, passing its imported component.

import type { Component } from 'vue'

export interface CrmDetailPanel {
  /** Stable id; a repeat registration with the same id replaces (HMR-safe). */
  id: string
  /** Record-type keys this panel renders for; omit/empty = every type. */
  recordTypes?: string[]
  /** The panel component, receiving `recordId` + `recordType` props. */
  component: Component
  /** Ascending render order among panels (default 100). */
  order?: number
}

const _crmDetailPanels: CrmDetailPanel[] = []

export function registerCrmDetailPanel(panel: CrmDetailPanel): void {
  const i = _crmDetailPanels.findIndex(p => p.id === panel.id)
  if (i >= 0) _crmDetailPanels[i] = panel
  else _crmDetailPanels.push(panel)
}

// Panels registered for a record type, order-sorted. Registration happens once
// at app-plugin init (before any record page renders), so the returned array is
// stable for the page's lifetime.
export function getCrmDetailPanels(recordType: string): CrmDetailPanel[] {
  return _crmDetailPanels
    .filter(p => !p.recordTypes?.length || p.recordTypes.includes(recordType))
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
}
