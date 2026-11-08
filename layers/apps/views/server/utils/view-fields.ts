// A view's own fields: declared in the view definition's `fields`, with
// values kept per view and record in views_values (files in
// records_attachments under `views:<viewId>:<fieldKey>`). Everyone who can
// open the view sees the same values; 'edit' fills them in; only the owner
// adds, changes or deletes fields. The records kernel never sees them, so a
// people field here grants nothing — it only records who is involved — and
// values never show outside the view.
//
// Filters, sorts, grouping and card layouts address view fields by key like
// the type's own fields: list queries get them as virtual fields, and the
// definition validators accept them (see `viewFieldsWithType`).

import { randomBytes } from 'node:crypto'
import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import { z } from 'zod'
import type { Database } from '#core/server/database/schema'
import { isActiveOrgMember, type TenantContext } from '#tenant/server'
import {
  applyAttachmentsPatch,
  deleteRecordAttachments,
  getRecordTypeFields,
  listRecordAttachments,
  normalizeChannelValue,
  RECORDS_VIRTUAL_SCALAR_KINDS
} from '#records/server'
import type { RecordsFieldSetting, RecordsFilterGroup, RecordsFilterNode, RecordsVirtualField } from '#records/server'
import type { RecordsAttachmentValue, RecordsLinkValue } from '#records'
import type { ViewDefinition, ViewRow, ViewTabDefinition } from './views'

type Tx = Transaction<Database>

export const VIEW_FIELD_KINDS = [
  'text',
  'textarea',
  'number',
  'boolean',
  'date',
  'key_select',
  'multi_select',
  'tags',
  'link',
  'user_select',
  'attachments'
] as const
export type ViewFieldKind = typeof VIEW_FIELD_KINDS[number]

export interface ViewFieldOption {
  label: string
  color?: string
}

/** One of a view's own fields, as stored in its definition. */
export interface ViewFieldDef {
  /** `vf_` + a slug of the label at creation; never changes. */
  key: string
  label: string
  kind: ViewFieldKind
  /** key_select / multi_select choices, in display order. */
  options?: Record<string, ViewFieldOption>
  /** user_select: several people. */
  multiple?: true
}

export const VIEW_FIELD_KEY_RE = /^vf_[a-z0-9_]{1,40}$/
export const VIEW_FIELDS_MAX = 30
const OPTION_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/
const OPTION_KINDS = new Set<ViewFieldKind>(['key_select', 'multi_select'])

const optionSchema = z.object({
  label: z.string().trim().min(1).max(80),
  color: z.string().max(32).optional()
}).strict()

export const viewFieldDefSchema = z.object({
  key: z.string().regex(VIEW_FIELD_KEY_RE),
  label: z.string().trim().min(1).max(80),
  kind: z.enum(VIEW_FIELD_KINDS),
  options: z.record(z.string().regex(OPTION_KEY_RE), optionSchema).optional(),
  multiple: z.literal(true).optional()
}).strict()

function badField(message: string): never {
  throw createError({ statusCode: 400, statusMessage: message })
}

/** Checks a field list's shape: unique keys, options only on select kinds. */
export function sanitizeViewFields(raw: unknown): ViewFieldDef[] {
  const parsed = z.array(viewFieldDefSchema).max(VIEW_FIELDS_MAX).safeParse(raw ?? [])
  if (!parsed.success) badField(`Invalid view fields: ${parsed.error.issues[0]?.message ?? 'malformed'}`)
  const keys = new Set<string>()
  for (const field of parsed.data) {
    if (keys.has(field.key)) badField(`Duplicate view field key "${field.key}"`)
    keys.add(field.key)
    if (field.options && !OPTION_KINDS.has(field.kind)) badField(`Only select fields have options ("${field.key}")`)
    if (OPTION_KINDS.has(field.kind) && Object.keys(field.options ?? {}).length === 0) {
      badField(`"${field.label}" needs at least one option`)
    }
    if (field.multiple && field.kind !== 'user_select') badField(`Only people fields take "multiple" ("${field.key}")`)
  }
  return parsed.data as ViewFieldDef[]
}

export function viewFieldsOf(view: Pick<ViewRow, 'definition'>): ViewFieldDef[] {
  return (view.definition as ViewDefinition).fields ?? []
}

/** Where files on a view's attachments field live in records_attachments. */
export function viewAttachmentKey(viewId: string, fieldKey: string): string {
  return `views:${viewId}:${fieldKey}`
}

function storageFor(kind: ViewFieldKind): RecordsFieldSetting['storage'] {
  if (RECORDS_VIRTUAL_SCALAR_KINDS.has(kind)) return 'jsonb'
  if (kind === 'user_select') return 'user_refs'
  if (kind === 'attachments') return 'attachments'
  return 'entries'
}

/** A view field shaped like a type field, for validators and grouping. */
export function viewFieldSetting(field: ViewFieldDef, index: number): RecordsFieldSetting {
  return {
    key: field.key,
    kind: field.kind,
    storage: storageFor(field.kind),
    label: field.label,
    required: false,
    hidden: false,
    order: 1000 + index,
    options: field.options,
    multiple: field.kind === 'user_select' ? field.multiple === true : undefined,
    custom: true,
    orphan: false
  }
}

/** The type's fields followed by the view's own. */
export async function viewFieldsWithType(tx: Tx, view: Pick<ViewRow, 'definition' | 'record_type_key'>): Promise<RecordsFieldSetting[]> {
  const typeFields = await getRecordTypeFields(tx, view.record_type_key)
  return [...typeFields, ...viewFieldsOf(view).map(viewFieldSetting)]
}

export function isViewFieldKey(view: Pick<ViewRow, 'definition'>, key: string): boolean {
  return viewFieldsOf(view).some(f => f.key === key)
}

/** The view's fields as list-query virtual fields, read from views_values. */
export function viewVirtualFields(view: Pick<ViewRow, 'id' | 'definition'>): RecordsVirtualField[] {
  return viewFieldsOf(view).map((field, index) => ({
    def: viewFieldSetting(field, index),
    value: field.kind === 'attachments'
      ? () => sql`(select jsonb_agg(va.id) from records_attachments va
          where va.record_id = records_entries.id and va.field_key = ${viewAttachmentKey(view.id, field.key)})`
      : () => sql`(select vv.value from views_values vv
          where vv.view_id = ${view.id}::uuid and vv.record_id = records_entries.id and vv.field_key = ${field.key})`
  }))
}

/** Every view-field value of each record: record id → field key → value. */
export async function readViewValues(
  tx: Tx,
  view: Pick<ViewRow, 'id' | 'definition'>,
  recordIds: string[]
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>()
  const fields = viewFieldsOf(view)
  if (fields.length === 0 || recordIds.length === 0) return out
  for (const id of recordIds) out.set(id, {})
  const rows = await tx
    .selectFrom('views_values')
    .select(['record_id', 'field_key', 'value'])
    .where('view_id', '=', view.id)
    .where('record_id', 'in', recordIds)
    .execute()
  const known = new Set(fields.map(f => f.key))
  for (const row of rows) {
    if (known.has(row.field_key)) out.get(row.record_id)![row.field_key] = row.value
  }
  const fileFields = fields.filter(f => f.kind === 'attachments')
  if (fileFields.length > 0) {
    const byKey = new Map(fileFields.map(f => [viewAttachmentKey(view.id, f.key), f.key]))
    const files = await listRecordAttachments(tx, recordIds, [...byKey.keys()])
    for (const [recordId, byField] of files) {
      for (const [storedKey, list] of byField) out.get(recordId)![byKey.get(storedKey)!] = list
    }
  }
  return out
}

/** The values a grouped board shows per record for one view field. */
export async function viewFieldGroupValues(
  tx: Tx,
  view: Pick<ViewRow, 'id' | 'definition'>,
  fieldKey: string,
  recordIds: string[]
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  for (const id of recordIds) out.set(id, [])
  if (recordIds.length === 0) return out
  const rows = await tx
    .selectFrom('views_values')
    .select(['record_id', 'value'])
    .where('view_id', '=', view.id)
    .where('field_key', '=', fieldKey)
    .where('record_id', 'in', recordIds)
    .execute()
  for (const row of rows) {
    const values = Array.isArray(row.value) ? row.value : [row.value]
    out.set(row.record_id, values.filter(v => typeof v === 'string' && v !== '') as string[])
  }
  return out
}

const uuid = z.string().uuid()

async function requireOrgUsers(tx: Tx, field: ViewFieldDef, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const rows = await tx.selectFrom('users').select('id').where('id', 'in', ids).execute()
  const found = new Set(rows.map(r => r.id))
  for (const id of ids) {
    if (!found.has(id) || !(await isActiveOrgMember(tx, id))) badField(`${field.label}: unknown user ${id}`)
  }
}

function optionKey(field: ViewFieldDef, raw: unknown): string {
  if (typeof raw !== 'string' || !field.options?.[raw]) badField(`${field.label}: '${String(raw)}' is not one of its options`)
  return raw
}

/**
 * A value as stored for `field`: a jsonb scalar or array, or null to clear.
 * Empty lists and empty text clear too.
 */
async function storedValue(tx: Tx, field: ViewFieldDef, raw: unknown): Promise<unknown> {
  if (raw === null || raw === undefined) return null
  switch (field.kind) {
    case 'text':
    case 'textarea': {
      if (typeof raw !== 'string') badField(`${field.label}: expected text`)
      if (raw.length > 10_000) badField(`${field.label}: too long`)
      return raw === '' ? null : raw
    }
    case 'number':
      if (typeof raw !== 'number' || !Number.isFinite(raw)) badField(`${field.label}: expected a number`)
      return raw
    case 'boolean':
      if (typeof raw !== 'boolean') badField(`${field.label}: expected true or false`)
      return raw
    case 'date':
      if (typeof raw !== 'string' || Number.isNaN(Date.parse(raw))) badField(`${field.label}: expected a date`)
      return raw
    case 'key_select':
      return optionKey(field, raw)
    case 'multi_select': {
      if (!Array.isArray(raw)) badField(`${field.label}: expected a list`)
      const keys = [...new Set(raw.map(v => optionKey(field, v)))]
      return keys.length > 0 ? keys : null
    }
    case 'tags': {
      if (!Array.isArray(raw)) badField(`${field.label}: expected a list`)
      const tags = [...new Set(raw.map((v) => {
        if (typeof v !== 'string' || v.trim() === '' || v.trim().length > 80) badField(`${field.label}: tags are short text`)
        return v.trim()
      }))]
      return tags.length > 0 ? tags : null
    }
    case 'link': {
      if (!Array.isArray(raw)) badField(`${field.label}: expected a list of links`)
      const links = raw.map((v): RecordsLinkValue => {
        const link = typeof v === 'string' ? { url: v } : v as { url?: unknown, label?: unknown }
        if (typeof link?.url !== 'string' || !normalizeChannelValue('url', link.url).valid) badField(`${field.label}: invalid link`)
        return typeof link.label === 'string' && link.label.trim() !== '' ? { url: link.url, label: link.label.trim() } : { url: link.url }
      })
      return links.length > 0 ? links : null
    }
    case 'user_select': {
      const list = Array.isArray(raw) ? raw : [raw]
      const ids = [...new Set(list.map((v) => {
        const parsed = uuid.safeParse(v)
        if (!parsed.success) badField(`${field.label}: expected user ids`)
        return parsed.data
      }))]
      const kept = field.multiple ? ids : ids.slice(-1)
      await requireOrgUsers(tx, field, kept)
      return kept.length > 0 ? kept : null
    }
    case 'attachments':
      badField(`${field.label}: files are added by upload`)
  }
}

/**
 * Sets view-field values on one record. Each key names one of the view's
 * fields; null (or an empty list) clears it. An attachments field takes the
 * files to keep, in order — new files come in by upload. The caller has
 * checked the record is in the view and that the caller may edit the view.
 */
export async function setViewValues(
  tx: Tx,
  ctx: TenantContext,
  view: Pick<ViewRow, 'id' | 'definition'>,
  recordId: string,
  patch: Record<string, unknown>
): Promise<void> {
  const fields = new Map(viewFieldsOf(view).map(f => [f.key, f]))
  for (const [key, raw] of Object.entries(patch)) {
    const field = fields.get(key)
    if (!field) badField(`Unknown view field: ${key}`)
    if (field.kind === 'attachments') {
      const list = Array.isArray(raw) ? raw : []
      await applyAttachmentsPatch(tx, recordId, viewAttachmentKey(view.id, key), {
        items: list.map(v => ({
          value: v !== null && typeof v === 'object' ? (v as RecordsAttachmentValue).id : v,
          delete: false
        })),
        force: true
      })
      continue
    }
    const value = await storedValue(tx, field, raw)
    if (value === null) {
      await tx
        .deleteFrom('views_values')
        .where('view_id', '=', view.id)
        .where('record_id', '=', recordId)
        .where('field_key', '=', key)
        .execute()
      continue
    }
    const json = sql`${JSON.stringify(value)}::text::jsonb`
    await tx
      .insertInto('views_values')
      .values({ view_id: view.id, record_id: recordId, field_key: key, value: json, updated_by: ctx.userId })
      .onConflict(oc => oc.columns(['view_id', 'record_id', 'field_key']).doUpdateSet({
        value: json,
        updated_by: ctx.userId,
        updated_at: sql`now()`
      }))
      .execute()
  }
}

/** Drops a record's view-field values (and files) on a view, when it leaves the view. */
export async function clearViewValues(tx: Tx, viewId: string, recordId: string): Promise<void> {
  await tx.deleteFrom('views_values').where('view_id', '=', viewId).where('record_id', '=', recordId).execute()
  await deleteRecordAttachments(tx, { fieldKeyPrefix: `views:${viewId}:`, recordIds: [recordId] })
}

/** Drops every file on the view's attachments fields, when the view goes. */
export async function clearViewFiles(tx: Tx, viewId: string): Promise<void> {
  await deleteRecordAttachments(tx, { fieldKeyPrefix: `views:${viewId}:` })
}

function slug(label: string): string {
  const base = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30)
  return base || 'field'
}

export interface ViewFieldInput {
  label: string
  kind: ViewFieldKind
  options?: Record<string, ViewFieldOption>
  multiple?: boolean
}

/**
 * A new field for the view, keyed from its label plus a random suffix. Keys
 * are never reused: a tab or filter still naming a deleted field must not
 * pick up a new field that happens to share its label.
 */
export function newViewField(existing: ViewFieldDef[], input: ViewFieldInput): ViewFieldDef {
  const taken = new Set(existing.map(f => f.key))
  let key: string
  do key = `vf_${slug(input.label)}_${randomBytes(3).toString('hex')}`
  while (taken.has(key))
  return {
    key,
    label: input.label.trim(),
    kind: input.kind,
    ...(input.options && OPTION_KINDS.has(input.kind) ? { options: input.options } : {}),
    ...(input.multiple && input.kind === 'user_select' ? { multiple: true as const } : {})
  }
}

// ---------------------------------------------------------------------------
// Field definitions (owner only — the routes check)
// ---------------------------------------------------------------------------

async function saveViewFields(tx: Tx, view: ViewRow, fields: ViewFieldDef[]): Promise<ViewRow> {
  const definition: ViewDefinition = { ...(view.definition as ViewDefinition) }
  if (fields.length > 0) definition.fields = sanitizeViewFields(fields)
  else delete definition.fields
  return await tx
    .updateTable('views_definitions')
    // jsonb params bind reliably only through the text cast.
    .set({ definition: sql`${JSON.stringify(definition)}::text::jsonb`, updated_at: sql`now()` })
    .where('id', '=', view.id)
    .returningAll()
    .executeTakeFirstOrThrow()
}

/** Adds a field to the view; returns the updated view and the new field. */
export async function addViewField(tx: Tx, view: ViewRow, input: ViewFieldInput): Promise<{ view: ViewRow, field: ViewFieldDef }> {
  const existing = viewFieldsOf(view)
  if (existing.length >= VIEW_FIELDS_MAX) badField(`A view has at most ${VIEW_FIELDS_MAX} fields of its own`)
  const field = newViewField(existing, input)
  return { view: await saveViewFields(tx, view, [...existing, field]), field }
}

export interface ViewFieldPatch {
  label?: string
  /** The whole option set, in order; replaces the current one. */
  options?: Record<string, ViewFieldOption>
  multiple?: boolean
}

// Takes choices that no longer exist off every card, so stored values always
// name current options (a write would otherwise refuse the stale one).
async function dropRemovedOptions(tx: Tx, viewId: string, field: ViewFieldDef, removed: string[]): Promise<void> {
  if (removed.length === 0) return
  const scope = sql`view_id = ${viewId}::uuid and field_key = ${field.key}`
  if (field.kind === 'key_select') {
    await sql`delete from views_values where ${scope} and value #>> '{}' = any(${removed}::text[])`.execute(tx)
    return
  }
  await sql`
    update views_values
    set value = coalesce((
      select jsonb_agg(e.v) from jsonb_array_elements_text(value) as e(v) where e.v <> all(${removed}::text[])
    ), '[]'::jsonb)
    where ${scope} and value ?| ${removed}::text[]
  `.execute(tx)
  await sql`delete from views_values where ${scope} and value = '[]'::jsonb`.execute(tx)
}

/** Renames a field or changes its options. Its key and kind never change. */
export async function updateViewField(tx: Tx, view: ViewRow, key: string, patch: ViewFieldPatch): Promise<ViewRow> {
  const fields = viewFieldsOf(view)
  const field = fields.find(f => f.key === key)
  if (!field) throw createError({ statusCode: 404, statusMessage: 'View field not found' })
  const next: ViewFieldDef = { ...field }
  if (patch.label !== undefined) next.label = patch.label.trim()
  if (patch.options !== undefined) {
    if (!OPTION_KINDS.has(field.kind)) badField(`Only select fields have options ("${field.label}")`)
    next.options = patch.options
    const kept = new Set(Object.keys(patch.options))
    await dropRemovedOptions(tx, view.id, field, Object.keys(field.options ?? {}).filter(k => !kept.has(k)))
  }
  if (patch.multiple !== undefined) {
    if (field.kind !== 'user_select') badField(`Only people fields take "multiple" ("${field.label}")`)
    if (patch.multiple) next.multiple = true
    else delete next.multiple
  }
  return await saveViewFields(tx, view, fields.map(f => (f.key === key ? next : f)))
}

// A filter tree without the rules on `key`; groups left empty go too.
function withoutField(group: RecordsFilterGroup | undefined, key: string): RecordsFilterGroup | undefined {
  if (!group) return undefined
  const rules: RecordsFilterNode[] = []
  for (const node of group.rules) {
    if ('rules' in node) {
      const inner = withoutField(node, key)
      if (inner) rules.push(inner)
    } else if (node.field !== key) {
      rules.push(node)
    }
  }
  return rules.length > 0 ? { ...group, rules } : undefined
}

/**
 * Deletes a field with its values and files, and takes it out of the view's
 * filter and every tab (filters, card fields, sort, list sections). A board
 * grouped by it shows the "grouping field missing" state until regrouped.
 */
export async function deleteViewField(tx: Tx, view: ViewRow, key: string): Promise<ViewRow> {
  const fields = viewFieldsOf(view)
  if (!fields.some(f => f.key === key)) throw createError({ statusCode: 404, statusMessage: 'View field not found' })
  await tx.deleteFrom('views_values').where('view_id', '=', view.id).where('field_key', '=', key).execute()
  await deleteRecordAttachments(tx, { fieldKeys: [viewAttachmentKey(view.id, key)] })

  const viewDef: ViewDefinition = { ...(view.definition as ViewDefinition) }
  const filter = withoutField(viewDef.filter, key)
  if (filter) viewDef.filter = filter
  else delete viewDef.filter
  view = { ...view, definition: viewDef as unknown as ViewRow['definition'] }

  const tabs = await tx.selectFrom('views_tabs').selectAll().where('view_id', '=', view.id).execute()
  for (const tab of tabs) {
    const def = { ...(tab.definition as ViewTabDefinition) }
    const before = JSON.stringify(def)
    const tabFilter = withoutField(def.filter, key)
    if (tabFilter) def.filter = tabFilter
    else delete def.filter
    if (def.cardFields) def.cardFields = def.cardFields.filter(f => f !== key)
    if (def.sort?.field === key) delete def.sort
    if (tab.layout === 'list' && def.groupField === key) delete def.groupField
    if (JSON.stringify(def) !== before) {
      await tx
        .updateTable('views_tabs')
        .set({ definition: sql`${JSON.stringify(def)}::text::jsonb`, updated_at: sql`now()` })
        .where('id', '=', tab.id)
        .execute()
    }
  }
  return await saveViewFields(tx, view, fields.filter(f => f.key !== key))
}
