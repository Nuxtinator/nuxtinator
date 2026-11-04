// Merged CRM definitions — code manifests/registrations ⊳ DB override rows.
// Built on core's `defineSettings` (see CLAUDE.md → "Settings pattern"): code
// is the source of truth for what exists, the DB stores only explicit
// customizations. Orphan rows are load-bearing here, not admin sugar — an
// admin-created record type is a crm_record_types row with `is_custom` and no
// code manifest, and an admin-created field is a crm_record_fields row with
// `kind` set — so every reader runs with orphans included.
//
// No cross-request caching: rows are org-scoped by RLS through the caller's
// tenant transaction, so a cached merge would leak one org's schema into
// another's requests. Every call re-reads.

import type { Selectable } from 'kysely'
import { defineSettings, type DbClient } from '#core/server/utils/settings'
import type { Database } from '#core/server/database/schema'
import { storageOf } from '#crm'
import type { CrmFieldDef, CrmFieldKind, CrmFieldOption, CrmRecordTypeManifest, CrmStorage } from '#crm'
import {
  getRegisteredRecordTypes,
  getRegisteredRecordType,
  getRegisteredChannelTypes,
  type CrmChannelTypeEntry
} from './crm-registry'
import type { CrmTypeRoleGrants } from './crm-perms'
import type { ChannelValueFormat } from '../database/schema.d'

type RecordTypeRow = Selectable<Database['crm_record_types']>
type RecordFieldRow = Selectable<Database['crm_record_fields']>
type ChannelTypeRow = Selectable<Database['crm_channel_types']>

// --- Record types ----------------------------------------------------------

export interface CrmRecordTypeSetting {
  key: string
  label: string
  labelSingular: string
  icon?: string
  statusField?: string
  /** Closed-reason field: config.closedReasonField ⊳ the manifest's. */
  closedReasonField?: string
  sections: Record<string, { label: string, order?: number }>
  hidden: boolean
  config: Record<string, unknown>
  /**
   * Per-role action grants from config.roleGrants — empty when absent. A
   * code-declared type needs an override row to carry grants; that is the
   * expected storage shape (grants are org data, never code defaults).
   */
  roleGrants: CrmTypeRoleGrants
  /** True for admin-created types (an is_custom row with no code manifest). */
  custom: boolean
  /** True for stale rows: no code manifest and not admin-created either. */
  orphan: boolean
  /** The code manifest, present only for code-declared types. */
  manifest?: CrmRecordTypeManifest
}

// The config.roleGrants slice, shape-checked — anything that isn't a plain
// object reads as "no grants" rather than corrupting the evaluator.
function roleGrantsOf(config: Record<string, unknown> | undefined): CrmTypeRoleGrants {
  const raw = config?.roleGrants
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as CrmTypeRoleGrants
  return {}
}

// config.closedReasonField: a field key picked in the schema builder, or
// null to drop the code-declared one. Absent means the manifest's.
function closedReasonFieldOf(config: Record<string, unknown> | undefined, fallback: string | undefined): string | undefined {
  if (!config || !('closedReasonField' in config)) return fallback
  const raw = config.closedReasonField
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

export const getRecordTypes = defineSettings<CrmRecordTypeManifest, RecordTypeRow, CrmRecordTypeSetting>({
  loadDefaults: () => getRegisteredRecordTypes(),
  loadOverrides: async (tx) => {
    const rows = await tx.selectFrom('crm_record_types').selectAll().execute()
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
        statusField: manifest.statusField,
        closedReasonField: closedReasonFieldOf(row?.config, manifest.closedReasonField),
        sections: manifest.sections ?? {},
        hidden: row?.hidden ?? false,
        config: row?.config ?? {},
        roleGrants: roleGrantsOf(row?.config),
        custom: false,
        orphan: false,
        manifest
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
      statusField: undefined,
      sections: {},
      hidden: r.hidden,
      config: r.config,
      roleGrants: roleGrantsOf(r.config),
      custom: r.is_custom,
      orphan: !r.is_custom
    }
  },
  includeOrphans: true
})

export async function getRecordType(tx: DbClient, typeKey: string): Promise<CrmRecordTypeSetting | null> {
  const all = await getRecordTypes(tx)
  return all.find(t => t.key === typeKey) ?? null
}

// --- Fields ----------------------------------------------------------------

export interface CrmFieldSetting {
  key: string
  kind: CrmFieldKind
  storage: CrmStorage
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
  options?: Record<string, CrmFieldOption>
  multiple?: boolean
  target?: string
  reverseKey?: string
  channelType?: string
  settings?: Record<string, unknown>
  /** True for admin-created custom fields (a row with `kind` set). */
  custom: boolean
  /** True for stale rows: no manifest field and no `kind` either. */
  orphan: boolean
}

// The slice of crm_record_fields.config the merge understands:
//   { options?: Record<optionKey, Partial<CrmFieldOption>> }
// Keys matching a manifest option override just the given props; keys the
// manifest doesn't declare are admin-added custom options.
function mergeOptions(
  base: Record<string, CrmFieldOption> | undefined,
  config: Record<string, unknown> | undefined
): Record<string, CrmFieldOption> | undefined {
  const overrides = config?.options as Record<string, Partial<CrmFieldOption>> | undefined
  if (!base && !overrides) return undefined
  const out: Record<string, CrmFieldOption> = {}
  for (const [key, option] of Object.entries(base ?? {})) out[key] = { ...option }
  for (const [key, override] of Object.entries(overrides ?? {})) {
    out[key] = { ...(out[key] ?? { label: key }), ...override }
  }
  return out
}

function mergeManifestField(key: string, def: CrmFieldDef, row: RecordFieldRow | undefined): CrmFieldSetting {
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
    // writes the desired state).
    hidden: row ? row.hidden : (def.hidden ?? false),
    order: row?.order_override ?? def.order ?? 0,
    default: def.default,
    options: mergeOptions(def.options, row?.config),
    multiple: def.multiple,
    target: def.target,
    reverseKey: def.reverseKey,
    channelType: def.channelType,
    settings: def.settings,
    custom: false,
    orphan: false
  }
}

function mergeOrphanField(row: RecordFieldRow): CrmFieldSetting {
  const custom = row.kind !== null
  const kind = (row.kind ?? 'text') as CrmFieldKind
  // Custom fields never promote to record columns and can't join the
  // user_refs/connections storage classes (those carry code-owned
  // semantics), so storage is clamped to entries or jsonb — except
  // communication_channel, whose one definition input (the channel type,
  // kept in config by the schema builder) is admin-suppliable, so it routes
  // to the channel service like a manifest channel field.
  const natural = storageOf({ kind })
  const storage = natural === 'channels' || natural === 'entries' ? natural : 'jsonb'
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
    custom,
    orphan: !custom
  }
}

// The name column is intrinsic to every record type — the create pipeline
// and the list engine resolve it through a field def with column: 'name'.
// Code manifests declare their own; types without a manifest (admin-created
// customs) get this synthesized def, which behaves like a code default:
// overridable via a crm_record_fields row but never deletable.
export const CRM_INTRINSIC_NAME_FIELD: CrmFieldDef = {
  kind: 'text',
  label: 'Name',
  column: 'name',
  required: true,
  order: 0
}

export async function getRecordTypeFields(tx: DbClient, typeKey: string): Promise<CrmFieldSetting[]> {
  const reader = defineSettings<{ key: string, def: CrmFieldDef }, RecordFieldRow, CrmFieldSetting>({
    loadDefaults: () => {
      const manifest = getRegisteredRecordType(typeKey)
      if (manifest) return Object.entries(manifest.fields).map(([key, def]) => ({ key, def }))
      return [{ key: 'name', def: CRM_INTRINSIC_NAME_FIELD }]
    },
    loadOverrides: async (tx) => {
      const rows = await tx
        .selectFrom('crm_record_fields')
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
  return fields.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
}

// --- Channel types ---------------------------------------------------------

export interface CrmChannelTypeSetting {
  typeKey: string
  label: string
  icon?: string
  valueFormat: ChannelValueFormat
  config: Record<string, unknown>
  /** True for admin-created channel types (a row with no code registration). */
  custom: boolean
}

export const getChannelTypes = defineSettings<CrmChannelTypeEntry, ChannelTypeRow, CrmChannelTypeSetting>({
  loadDefaults: () => getRegisteredChannelTypes(),
  loadOverrides: async (tx) => {
    const rows = await tx.selectFrom('crm_channel_types').selectAll().execute()
    return new Map(rows.map(r => [r.type_key, r]))
  },
  keyOf: t => t.typeKey,
  merge: (entry, row) => {
    if (entry) {
      return {
        typeKey: entry.typeKey,
        label: row?.label ?? entry.label,
        icon: entry.icon,
        // value_format is code-owned for code-registered types; a row's
        // format only matters for admin-created ones.
        valueFormat: entry.valueFormat,
        config: row?.config ?? {},
        custom: false
      }
    }
    const r = row!
    return {
      typeKey: r.type_key,
      label: r.label ?? r.type_key,
      icon: undefined,
      valueFormat: r.value_format ?? 'freeform',
      config: r.config,
      custom: true
    }
  },
  includeOrphans: true
})

export async function getChannelType(tx: DbClient, typeKey: string): Promise<CrmChannelTypeSetting | null> {
  const all = await getChannelTypes(tx)
  return all.find(t => t.typeKey === typeKey) ?? null
}
