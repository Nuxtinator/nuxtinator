// Org-level schema-builder mutations over the CRM definition tables.
//
// Everything here follows the code-owned-defaults contract enforced by the
// merged readers in ./definition-settings:
//   - crm_record_types rows are EITHER admin-created types (`is_custom`) OR
//     override rows for code-declared types. Override rows never carry a
//     value equal to the code default — such values are stored as NULL, and a
//     row whose overrides are all empty is deleted outright.
//   - crm_record_fields rows are EITHER admin-created custom fields (`kind`
//     set) OR override rows for manifest fields (`kind` NULL). Same
//     minimal-override rule applies; per-option overrides and admin-added
//     custom options live under config.options.
//   - crm_channel_types rows are admin-created channel types; collisions with
//     code-registered channel types are rejected rather than merged.
//
// Every mutation validates against the merged readers first (never against
// the raw tables), so uniqueness means "unique across code + DB". All reads
// and writes go through the caller's tenant transaction — org scoping is
// RLS, never explicit org_id handling (per-app tenancy migrations add the
// column; single mode has none).

import { sql } from 'kysely'
import type { Selectable, Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { TenantContext } from '#tenant/server'
import { storageOf } from '#crm'
import type { CrmFieldDef, CrmFieldKind, CrmFieldOption } from '#crm'
import {
  getRecordType,
  getRecordTypes,
  getRecordTypeFields,
  getChannelType,
  getChannelTypes,
  CRM_INTRINSIC_NAME_FIELD,
  type CrmRecordTypeSetting,
  type CrmFieldSetting,
  type CrmChannelTypeSetting
} from './definition-settings'
import { getRegisteredRecordType } from './crm-registry'
import { CRM_RECORD_ACTIONS, type CrmRecordAction, type CrmTypeRoleGrants } from './crm-perms'
import type { ChannelValueFormat } from '../database/schema.d'

type Tx = Transaction<Database>
type RecordFieldRow = Selectable<Database['crm_record_fields']>

// Slugs are immutable identities (rename = label change), so they get the
// strict form: lowercase start, 2–41 chars of [a-z0-9_].
export const CRM_SCHEMA_SLUG_RE = /^[a-z][a-z0-9_]{1,40}$/
// Option keys may start with a digit (the contacts manifest ships '18_25').
export const CRM_OPTION_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/

// Field kinds admins may create. user_select and connection carry code-owned
// semantics — reverse keys, user-ref hydration — that a runtime definition
// can't supply, so admin fields are limited to kinds whose storage resolves
// to jsonb or entries, plus communication_channel: its one definition input
// (the channel type) is admin-suppliable and the channel service handles the
// rest.
export const CRM_ADMIN_FIELD_KINDS = [
  'text',
  'textarea',
  'number',
  'boolean',
  'date',
  'datetime',
  'key_select',
  'multi_select',
  'tags',
  'link',
  'communication_channel'
] as const
export type CrmAdminFieldKind = typeof CRM_ADMIN_FIELD_KINDS[number]

// The five code-owned channel value formats (mirrored by the CHECK constraint
// on crm_channel_types.value_format).
export const CRM_CHANNEL_VALUE_FORMATS = ['email', 'phone', 'handle', 'url', 'freeform'] as const

/** Kinds whose definition may carry an options vocabulary. */
const OPTION_KINDS = new Set<CrmFieldKind>(['key_select', 'multi_select', 'tags'])

function bad(message: string): never {
  throw createError({ statusCode: 400, statusMessage: message })
}

function conflict(message: string): never {
  throw createError({ statusCode: 409, statusMessage: message })
}

function notFound(message: string): never {
  throw createError({ statusCode: 404, statusMessage: message })
}

// House style for jsonb binds: pre-stringify and route through ::text so
// postgres-js can't JSON-encode the value a second time.
function jsonb(value: unknown) {
  return sql<Record<string, unknown>>`${JSON.stringify(value)}::text::jsonb`
}

async function countRecordsOfType(tx: Tx, typeKey: string): Promise<number> {
  const row = await tx
    .selectFrom('crm_records')
    .select(eb => eb.fn.countAll().as('total'))
    .where('record_type', '=', typeKey)
    .executeTakeFirst()
  return Number(row?.total ?? 0)
}

// --- Record types ----------------------------------------------------------

export interface CreateRecordTypeInput {
  typeKey: string
  label: string
  labelSingular: string
  icon?: string
}

export async function createRecordType(
  tx: Tx,
  ctx: TenantContext,
  input: CreateRecordTypeInput
): Promise<CrmRecordTypeSetting> {
  if (!CRM_SCHEMA_SLUG_RE.test(input.typeKey)) {
    bad('Type key must be a slug: [a-z][a-z0-9_]{1,40}')
  }
  const existing = await getRecordTypes(tx)
  if (existing.some(t => t.key === input.typeKey)) {
    conflict(`Record type '${input.typeKey}' already exists`)
  }
  // For admin-created types the *_override columns are the primary storage —
  // labels here are user content, not duplicated code defaults.
  await tx
    .insertInto('crm_record_types')
    .values({
      type_key: input.typeKey,
      label_override: input.label,
      label_singular_override: input.labelSingular,
      icon_override: input.icon ?? null,
      is_custom: true,
      updated_by: ctx.userId,
      updated_at: sql`now()`
    })
    .execute()
  return (await getRecordType(tx, input.typeKey))!
}

export interface UpdateRecordTypePatch {
  /** undefined = untouched; null = revert to the code default (code types only). */
  label?: string | null
  labelSingular?: string | null
  icon?: string | null
  hidden?: boolean
  /** Section keys in display order; null clears the override. */
  sectionOrder?: string[] | null
  /**
   * Field key of the key_select that holds why a closed record was closed;
   * null reverts to the code default. Types with a status field only.
   */
  closedReasonField?: string | null
}

// The code-default section ordering a sectionOrder override is compared
// against: sections sorted by declared order, then key.
function defaultSectionOrder(sections: Record<string, { label: string, order?: number }>): string[] {
  return Object.entries(sections)
    .sort((a, b) => (a[1].order ?? 0) - (b[1].order ?? 0) || a[0].localeCompare(b[0]))
    .map(([key]) => key)
}

function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

export async function updateRecordType(
  tx: Tx,
  ctx: TenantContext,
  typeKey: string,
  patch: UpdateRecordTypePatch
): Promise<CrmRecordTypeSetting> {
  const type = await getRecordType(tx, typeKey)
  // Orphan rows are stale leftovers — they can be deleted, not edited.
  if (!type || type.orphan) notFound(`Unknown record type: ${typeKey}`)

  const row = await tx
    .selectFrom('crm_record_types')
    .selectAll()
    .where('type_key', '=', typeKey)
    .executeTakeFirst()

  const manifest = type.manifest
  const config: Record<string, unknown> = { ...(row?.config ?? {}) }

  // Desired column state, starting from what the row already stores.
  let label = row?.label_override ?? null
  let labelSingular = row?.label_singular_override ?? null
  let icon = row?.icon_override ?? null
  let hidden = row?.hidden ?? false

  if (manifest) {
    // Code type: store only actual overrides; a patched value equal to the
    // code default (or an explicit null) reverts to "no override".
    if (patch.label !== undefined) {
      label = patch.label === null || patch.label === manifest.label ? null : patch.label
    }
    if (patch.labelSingular !== undefined) {
      labelSingular = patch.labelSingular === null || patch.labelSingular === manifest.labelSingular
        ? null
        : patch.labelSingular
    }
    if (patch.icon !== undefined) {
      icon = patch.icon === null || patch.icon === (manifest.icon ?? null) ? null : patch.icon
    }
    if (patch.sectionOrder !== undefined) {
      if (patch.sectionOrder === null || patch.sectionOrder.length === 0) {
        delete config.sectionOrder
      } else {
        const declared = manifest.sections ?? {}
        for (const key of patch.sectionOrder) {
          if (!(key in declared)) bad(`Unknown section: ${key}`)
        }
        if (sameOrder(patch.sectionOrder, defaultSectionOrder(declared))) {
          delete config.sectionOrder
        } else {
          config.sectionOrder = patch.sectionOrder
        }
      }
    }
  } else {
    // Custom type: the row is the definition; labels are required content.
    if (patch.label !== undefined) {
      if (patch.label === null) bad('Custom record types require a label')
      label = patch.label
    }
    if (patch.labelSingular !== undefined) {
      if (patch.labelSingular === null) bad('Custom record types require a singular label')
      labelSingular = patch.labelSingular
    }
    if (patch.icon !== undefined) icon = patch.icon
    if (patch.sectionOrder !== undefined) {
      if (patch.sectionOrder === null || patch.sectionOrder.length === 0) {
        delete config.sectionOrder
      } else {
        config.sectionOrder = patch.sectionOrder
      }
    }
  }
  if (patch.hidden !== undefined) hidden = patch.hidden
  if (patch.closedReasonField !== undefined) {
    if (!type.statusField) bad('Only record types with a status field can have a closed reason')
    const fallback = manifest?.closedReasonField ?? null
    if (patch.closedReasonField === null || patch.closedReasonField === fallback) {
      delete config.closedReasonField
    } else {
      const fields = await getRecordTypeFields(tx, typeKey)
      const field = fields.find(f => f.key === patch.closedReasonField && !f.orphan)
      if (!field || field.kind !== 'key_select' || field.column) {
        bad(`${patch.closedReasonField} is not a single-choice field of ${typeKey}`)
      }
      config.closedReasonField = patch.closedReasonField
    }
  }

  const hasOverrides = label !== null
    || labelSingular !== null
    || icon !== null
    || hidden !== false
    || Object.keys(config).length > 0

  if (manifest && !hasOverrides) {
    // Everything reverted to code defaults — the row would be a no-op, so it
    // goes away entirely rather than persisting default-equal values.
    if (row) {
      await tx.deleteFrom('crm_record_types').where('id', '=', row.id).execute()
    }
  } else if (row) {
    await tx
      .updateTable('crm_record_types')
      .set({
        label_override: label,
        label_singular_override: labelSingular,
        icon_override: icon,
        hidden,
        config: jsonb(config),
        updated_by: ctx.userId,
        updated_at: sql`now()`
      })
      .where('id', '=', row.id)
      .execute()
  } else {
    await tx
      .insertInto('crm_record_types')
      .values({
        type_key: typeKey,
        label_override: label,
        label_singular_override: labelSingular,
        icon_override: icon,
        hidden,
        config: jsonb(config),
        is_custom: false,
        updated_by: ctx.userId,
        updated_at: sql`now()`
      })
      .execute()
  }

  return (await getRecordType(tx, typeKey))!
}

// Replaces a type's per-role action grants (config.roleGrants) with the
// given desired state. Only explicit true/false entries persist — an absent
// (role, action) pair means "inherit from the role's slugs" and is never
// written; role objects left empty after stripping are dropped, and the
// config key is deleted outright when no grants remain (so a code type whose
// row carries nothing else reverts to no row at all, per the code-owned
// defaults contract). Role keys are only shape-checked here — whether a role
// actually exists is the caller's concern.
export async function updateTypeRoleGrants(
  tx: Tx,
  ctx: TenantContext,
  typeKey: string,
  grants: CrmTypeRoleGrants
): Promise<CrmRecordTypeSetting> {
  const type = await getRecordType(tx, typeKey)
  if (!type || type.orphan) notFound(`Unknown record type: ${typeKey}`)

  const clean: CrmTypeRoleGrants = {}
  for (const [role, actions] of Object.entries(grants)) {
    if (role.trim() === '') bad('Role keys must be non-empty strings')
    if (typeof actions !== 'object' || actions === null || Array.isArray(actions)) {
      bad(`Invalid grants for role '${role}'`)
    }
    const cleanActions: Partial<Record<CrmRecordAction, boolean>> = {}
    for (const [action, value] of Object.entries(actions)) {
      if (!(CRM_RECORD_ACTIONS as readonly string[]).includes(action)) {
        bad(`Unknown action: ${action}`)
      }
      if (typeof value !== 'boolean') {
        bad(`Grants must be explicit true/false (role '${role}', action '${action}')`)
      }
      cleanActions[action as CrmRecordAction] = value
    }
    if (Object.keys(cleanActions).length > 0) clean[role] = cleanActions
  }

  const row = await tx
    .selectFrom('crm_record_types')
    .selectAll()
    .where('type_key', '=', typeKey)
    .executeTakeFirst()

  const config: Record<string, unknown> = { ...(row?.config ?? {}) }
  if (Object.keys(clean).length > 0) config.roleGrants = clean
  else delete config.roleGrants

  const hasOverrides = (row?.label_override ?? null) !== null
    || (row?.label_singular_override ?? null) !== null
    || (row?.icon_override ?? null) !== null
    || (row?.hidden ?? false) !== false
    || Object.keys(config).length > 0

  if (type.manifest && !hasOverrides) {
    // The row carried nothing but the grants that were just cleared.
    if (row) {
      await tx.deleteFrom('crm_record_types').where('id', '=', row.id).execute()
    }
  } else if (row) {
    await tx
      .updateTable('crm_record_types')
      .set({
        config: jsonb(config),
        updated_by: ctx.userId,
        updated_at: sql`now()`
      })
      .where('id', '=', row.id)
      .execute()
  } else {
    await tx
      .insertInto('crm_record_types')
      .values({
        type_key: typeKey,
        config: jsonb(config),
        is_custom: false,
        updated_by: ctx.userId,
        updated_at: sql`now()`
      })
      .execute()
  }

  return (await getRecordType(tx, typeKey))!
}

export async function deleteRecordType(
  tx: Tx,
  _ctx: TenantContext,
  typeKey: string
): Promise<void> {
  const type = await getRecordType(tx, typeKey)
  if (!type) notFound(`Unknown record type: ${typeKey}`)
  // Code-declared types can only be hidden or reverted, never deleted —
  // their existence is a code fact. Custom types and stale orphan rows are
  // DB-only and deletable.
  if (type.manifest) bad('Code-declared record types cannot be deleted')
  const total = await countRecordsOfType(tx, typeKey)
  if (total > 0) {
    conflict(`Cannot delete '${typeKey}': ${total} record${total === 1 ? '' : 's'} of this type exist`)
  }
  // No FK links crm_record_fields to crm_record_types (both are keyed by the
  // open type_key vocabulary), so the field rows cascade explicitly.
  await tx.deleteFrom('crm_record_fields').where('type_key', '=', typeKey).execute()
  await tx.deleteFrom('crm_record_types').where('type_key', '=', typeKey).execute()
}

// --- Fields ----------------------------------------------------------------

export interface CreateFieldInput {
  fieldKey: string
  kind: CrmAdminFieldKind
  label: string
  icon?: string
  section?: string
  required?: boolean
  options?: Record<string, CrmFieldOption>
  /** communication_channel only: the merged channel-type key the field holds. */
  channelType?: string
}

function validateOptionRecord(options: Record<string, CrmFieldOption>): void {
  for (const [key, option] of Object.entries(options)) {
    if (!CRM_OPTION_KEY_RE.test(key)) bad(`Invalid option key: ${key}`)
    if (!option.label || option.label.trim().length === 0) bad(`Option '${key}' requires a label`)
    // Custom fields are never the status column, so no option means closed.
    if (option.closed) bad(`Only status options can count as closed`)
    delete option.revokesConsent
  }
}

// Sections on code types reference the manifest's code-owned section map;
// custom/orphan types have no declared sections, so their fields may carry
// any (bounded) section string and the set of sections emerges from usage.
function validateSection(type: CrmRecordTypeSetting, section: string): void {
  if (type.manifest) {
    if (!(section in (type.manifest.sections ?? {}))) bad(`Unknown section: ${section}`)
  } else if (section.length > 60) {
    bad('Section keys are limited to 60 characters')
  }
}

export async function createField(
  tx: Tx,
  ctx: TenantContext,
  typeKey: string,
  input: CreateFieldInput
): Promise<CrmFieldSetting> {
  const type = await getRecordType(tx, typeKey)
  if (!type || type.orphan) notFound(`Unknown record type: ${typeKey}`)
  if (!CRM_SCHEMA_SLUG_RE.test(input.fieldKey)) {
    bad('Field key must be a slug: [a-z][a-z0-9_]{1,40}')
  }
  // name/status are intrinsic record columns on every type (the list engine
  // always resolves them), so a custom field can never claim those keys.
  if (input.fieldKey === 'name' || input.fieldKey === 'status') {
    bad(`'${input.fieldKey}' is a reserved field key`)
  }
  if (!(CRM_ADMIN_FIELD_KINDS as readonly string[]).includes(input.kind)) {
    bad(`Unsupported field kind: ${input.kind}`)
  }
  // Belt and braces: the whitelist above already guarantees this, but the
  // storage contract (custom fields live in jsonb, entries, or the channel
  // service) is what actually matters downstream.
  const storage = storageOf({ kind: input.kind })
  if (storage !== 'jsonb' && storage !== 'entries' && storage !== 'channels') {
    bad(`Unsupported field kind: ${input.kind}`)
  }

  // A channel field is unusable without its channel type — the widget and
  // the channel routes resolve normalization and dedupe through it. The key
  // must exist in the merged catalog (code-registered or admin-created) and
  // is stored in the field row's config.
  if (input.kind === 'communication_channel') {
    if (!input.channelType) bad('communication_channel fields require a channelType')
    const channelType = await getChannelType(tx, input.channelType)
    if (!channelType) bad(`Unknown channel type: ${input.channelType}`)
  } else if (input.channelType !== undefined) {
    bad(`'${input.kind}' fields do not take a channel type`)
  }

  const fields = await getRecordTypeFields(tx, typeKey)
  if (fields.some(f => f.key === input.fieldKey)) {
    conflict(`Field '${input.fieldKey}' already exists on '${typeKey}'`)
  }

  if (input.options) {
    if (!OPTION_KINDS.has(input.kind)) bad(`'${input.kind}' fields do not take options`)
    validateOptionRecord(input.options)
  }
  if (input.section !== undefined) validateSection(type, input.section)

  // New fields land after everything currently defined.
  const maxOrder = fields.reduce((max, f) => Math.max(max, f.order), 0)

  await tx
    .insertInto('crm_record_fields')
    .values({
      type_key: typeKey,
      field_key: input.fieldKey,
      // `kind` set marks the row as an admin-created custom field (vs an
      // override row for a manifest field, where kind stays NULL).
      kind: input.kind,
      label_override: input.label,
      icon_override: input.icon ?? null,
      section_override: input.section ?? null,
      required_override: input.required ? true : null,
      order_override: maxOrder + 1,
      config: jsonb({
        ...(input.options ? { options: input.options } : {}),
        ...(input.channelType ? { channelType: input.channelType } : {})
      }),
      updated_by: ctx.userId,
      updated_at: sql`now()`
    })
    .execute()

  const merged = await getRecordTypeFields(tx, typeKey)
  return merged.find(f => f.key === input.fieldKey)!
}

export interface UpdateFieldPatch {
  /** undefined = untouched; null = revert to the code default (manifest fields only). */
  label?: string | null
  /** undefined = untouched; null = revert to the code default / no icon. */
  icon?: string | null
  hidden?: boolean
  required?: boolean | null
  order?: number | null
  section?: string | null
  /**
   * Per-option desired state, keyed by option key. Each value is the option's
   * complete desired shape (props omitted fall back to the code default);
   * null removes the override / custom option entirely. For manifest fields
   * only the props that differ from the manifest option are persisted.
   */
  options?: Record<string, CrmFieldOption | null>
}

/** Props of `desired` that differ from the manifest option — the persisted override. */
function diffOption(desired: CrmFieldOption, base: CrmFieldOption): Partial<CrmFieldOption> {
  const diff: Partial<CrmFieldOption> = {}
  if (desired.label !== undefined && desired.label !== base.label) diff.label = desired.label
  if (desired.color !== undefined && desired.color !== base.color) diff.color = desired.color
  if (desired.description !== undefined && desired.description !== base.description) diff.description = desired.description
  if ((desired.deleted ?? false) !== (base.deleted ?? false)) diff.deleted = desired.deleted ?? false
  if (desired.closed !== undefined && desired.closed !== (base.closed ?? false)) diff.closed = desired.closed
  return diff
}

function applyManifestOptionPatch(
  def: CrmFieldDef,
  config: Record<string, unknown>,
  patch: Record<string, CrmFieldOption | null>
): void {
  const overrides = { ...((config.options as Record<string, Partial<CrmFieldOption>> | undefined) ?? {}) }
  for (const [key, raw] of Object.entries(patch)) {
    if (!CRM_OPTION_KEY_RE.test(key)) bad(`Invalid option key: ${key}`)
    if (raw === null) {
      // Revert a manifest option to its code default / drop a custom option.
      delete overrides[key]
      continue
    }
    // Which reasons revoke consent is code-owned; admins can't set it.
    const { revokesConsent: _revokes, ...desired } = raw
    if (desired.closed && def.column !== 'status') bad(`Only status options can count as closed`)
    const base = def.options?.[key]
    if (base) {
      const diff = diffOption(desired, base)
      if (Object.keys(diff).length > 0) overrides[key] = diff
      else delete overrides[key]
    } else {
      // Admin-added custom option: the override row is its whole definition.
      if (!desired.label || desired.label.trim().length === 0) bad(`Option '${key}' requires a label`)
      overrides[key] = desired
    }
  }
  if (Object.keys(overrides).length > 0) config.options = overrides
  else delete config.options
}

function applyCustomOptionPatch(
  config: Record<string, unknown>,
  patch: Record<string, CrmFieldOption | null>
): void {
  const options = { ...((config.options as Record<string, CrmFieldOption> | undefined) ?? {}) }
  for (const [key, raw] of Object.entries(patch)) {
    if (!CRM_OPTION_KEY_RE.test(key)) bad(`Invalid option key: ${key}`)
    if (raw === null) {
      delete options[key]
      continue
    }
    const { revokesConsent: _revokes, ...desired } = raw
    if (!desired.label || desired.label.trim().length === 0) bad(`Option '${key}' requires a label`)
    if (desired.closed) bad(`Only status options can count as closed`)
    options[key] = desired
  }
  if (Object.keys(options).length > 0) config.options = options
  else delete config.options
}

async function getFieldRow(tx: Tx, typeKey: string, fieldKey: string): Promise<RecordFieldRow | undefined> {
  return await tx
    .selectFrom('crm_record_fields')
    .selectAll()
    .where('type_key', '=', typeKey)
    .where('field_key', '=', fieldKey)
    .executeTakeFirst()
}

export async function updateField(
  tx: Tx,
  ctx: TenantContext,
  typeKey: string,
  fieldKey: string,
  patch: UpdateFieldPatch
): Promise<CrmFieldSetting> {
  const type = await getRecordType(tx, typeKey)
  if (!type || type.orphan) notFound(`Unknown record type: ${typeKey}`)
  const fields = await getRecordTypeFields(tx, typeKey)
  const field = fields.find(f => f.key === fieldKey)
  if (!field) notFound(`Unknown field: ${fieldKey}`)

  if (patch.section !== undefined && patch.section !== null) {
    validateSection(type, patch.section)
  }

  const row = await getFieldRow(tx, typeKey, fieldKey)
  // The intrinsic name field of a manifest-less type carries code-owned
  // semantics too — it takes the same minimal-override treatment as a
  // manifest field (see CRM_INTRINSIC_NAME_FIELD).
  const def = getRegisteredRecordType(typeKey)?.fields[fieldKey]
    ?? (fieldKey === 'name' && !type.manifest ? CRM_INTRINSIC_NAME_FIELD : undefined)

  if (def) {
    // Manifest field — persist only actual overrides.
    const config: Record<string, unknown> = { ...(row?.config ?? {}) }
    let label = row?.label_override ?? null
    let icon = row?.icon_override ?? null
    let required = row?.required_override ?? null
    let order = row?.order_override ?? null
    let section = row?.section_override ?? null
    let hidden = row ? row.hidden : (def.hidden ?? false)

    if (patch.label !== undefined) {
      label = patch.label === null || patch.label === def.label ? null : patch.label
    }
    if (patch.icon !== undefined) {
      icon = patch.icon === null || patch.icon === (def.icon ?? null) ? null : patch.icon
    }
    if (patch.required !== undefined) {
      required = patch.required === null || patch.required === (def.required ?? false)
        ? null
        : patch.required
    }
    if (patch.order !== undefined) {
      order = patch.order === null || patch.order === (def.order ?? 0) ? null : patch.order
    }
    if (patch.section !== undefined) {
      section = patch.section === null || patch.section === (def.section ?? null)
        ? null
        : patch.section
    }
    if (patch.hidden !== undefined) hidden = patch.hidden
    if (patch.options !== undefined) {
      if (!OPTION_KINDS.has(def.kind)) bad(`'${def.kind}' fields do not take options`)
      applyManifestOptionPatch(def, config, patch.options)
    }

    const hasOverrides = label !== null
      || icon !== null
      || required !== null
      || order !== null
      || section !== null
      || hidden !== (def.hidden ?? false)
      || Object.keys(config).length > 0

    if (!hasOverrides) {
      if (row) {
        await tx.deleteFrom('crm_record_fields').where('id', '=', row.id).execute()
      }
    } else if (row) {
      await tx
        .updateTable('crm_record_fields')
        .set({
          label_override: label,
          icon_override: icon,
          required_override: required,
          order_override: order,
          section_override: section,
          hidden,
          config: jsonb(config),
          updated_by: ctx.userId,
          updated_at: sql`now()`
        })
        .where('id', '=', row.id)
        .execute()
    } else {
      await tx
        .insertInto('crm_record_fields')
        .values({
          type_key: typeKey,
          field_key: fieldKey,
          kind: null,
          label_override: label,
          icon_override: icon,
          required_override: required,
          order_override: order,
          section_override: section,
          hidden,
          config: jsonb(config),
          updated_by: ctx.userId,
          updated_at: sql`now()`
        })
        .execute()
    }
  } else {
    // Custom (kind set) or stale orphan row — the row is the definition, so
    // values are stored directly. A row is guaranteed here: a merged field
    // without a manifest def can only have come from one.
    const r = row!
    const config: Record<string, unknown> = { ...r.config }
    let label = r.label_override
    let icon = r.icon_override
    let required = r.required_override
    let order = r.order_override
    let section = r.section_override
    let hidden = r.hidden

    if (patch.label !== undefined) {
      if (patch.label === null) bad('Custom fields require a label')
      label = patch.label
    }
    if (patch.icon !== undefined) icon = patch.icon
    if (patch.required !== undefined) required = patch.required
    if (patch.order !== undefined) order = patch.order
    if (patch.section !== undefined) section = patch.section
    if (patch.hidden !== undefined) hidden = patch.hidden
    if (patch.options !== undefined) {
      if (!field.custom || !OPTION_KINDS.has(field.kind)) {
        bad(`'${field.kind}' fields do not take options`)
      }
      applyCustomOptionPatch(config, patch.options)
    }

    await tx
      .updateTable('crm_record_fields')
      .set({
        label_override: label,
        icon_override: icon,
        required_override: required,
        order_override: order,
        section_override: section,
        hidden,
        config: jsonb(config),
        updated_by: ctx.userId,
        updated_at: sql`now()`
      })
      .where('id', '=', r.id)
      .execute()
  }

  const merged = await getRecordTypeFields(tx, typeKey)
  return merged.find(f => f.key === fieldKey)!
}

export async function deleteField(
  tx: Tx,
  _ctx: TenantContext,
  typeKey: string,
  fieldKey: string
): Promise<void> {
  const type = await getRecordType(tx, typeKey)
  if (!type || type.orphan) notFound(`Unknown record type: ${typeKey}`)
  const fields = await getRecordTypeFields(tx, typeKey)
  const field = fields.find(f => f.key === fieldKey)
  if (!field) notFound(`Unknown field: ${fieldKey}`)

  const row = await getFieldRow(tx, typeKey, fieldKey)

  if (field.custom || field.orphan) {
    // Custom/stale field: the row is the definition. Stored values in
    // data/entries become orphans, which the readers tolerate.
    await tx.deleteFrom('crm_record_fields').where('id', '=', row!.id).execute()
    return
  }
  // Manifest field: the field itself is a code fact — "delete" clears its
  // override row, restoring the code defaults.
  if (!row) bad(`Field '${fieldKey}' has no overrides to clear`)
  await tx.deleteFrom('crm_record_fields').where('id', '=', row.id).execute()
}

// --- Channel types ---------------------------------------------------------

export interface CreateChannelTypeInput {
  typeKey: string
  label: string
  valueFormat: ChannelValueFormat
  icon?: string
}

export async function createChannelType(
  tx: Tx,
  _ctx: TenantContext,
  input: CreateChannelTypeInput
): Promise<CrmChannelTypeSetting> {
  if (!CRM_SCHEMA_SLUG_RE.test(input.typeKey)) {
    bad('Channel type key must be a slug: [a-z][a-z0-9_]{1,40}')
  }
  if (!(CRM_CHANNEL_VALUE_FORMATS as readonly string[]).includes(input.valueFormat)) {
    bad(`Unknown value format: ${input.valueFormat}`)
  }
  const existing = await getChannelTypes(tx)
  if (existing.some(t => t.typeKey === input.typeKey)) {
    conflict(`Channel type '${input.typeKey}' already exists`)
  }
  await tx
    .insertInto('crm_channel_types')
    .values({
      type_key: input.typeKey,
      label: input.label,
      value_format: input.valueFormat,
      // The table has no icon column; admin-chosen icons ride in config and
      // read endpoints surface config.icon for custom channel types.
      config: jsonb(input.icon ? { icon: input.icon } : {})
    })
    .execute()
  return (await getChannelType(tx, input.typeKey))!
}

export async function removeChannelType(
  tx: Tx,
  _ctx: TenantContext,
  typeKey: string
): Promise<void> {
  const type = await getChannelType(tx, typeKey)
  if (!type) notFound(`Unknown channel type: ${typeKey}`)
  // Code-registered channel types are code facts — a row under the same key
  // could only be a label override, so there is nothing deletable.
  if (!type.custom) bad('Code-registered channel types cannot be deleted')
  // Claimed addresses of this type carry consent/suppression history; the
  // type stays until those channel rows are gone.
  const row = await tx
    .selectFrom('crm_channels')
    .select(eb => eb.fn.countAll().as('total'))
    .where('channel_type', '=', typeKey)
    .executeTakeFirst()
  const total = Number(row?.total ?? 0)
  if (total > 0) {
    conflict(`Cannot delete '${typeKey}': ${total} channel${total === 1 ? '' : 's'} of this type exist`)
  }
  await tx.deleteFrom('crm_channel_types').where('type_key', '=', typeKey).execute()
}
