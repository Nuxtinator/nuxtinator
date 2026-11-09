// Record hydration + the storage-routed field patch pipeline.
//
// A record's logical fields live in these physical homes (see `storageOf` in
// #records): promoted columns on records_entries, keys in records_entries.data,
// records_field_entries rows, records_user_refs rows, records_connections
// rows, records_attachments rows, and driver-backed storages (channel links).
// `hydrateRecords` reads them
// all back into one flat `fields` map (one query per storage class, batched
// over records); `applyFieldPatch` routes writes the other way:
//
//   merged defs → field-filter hook chain → per-kind validation →
//   closing rules (./closing) → storage-routed writes → updated_at bump →
//   activity rows per changed field → closing hooks on close
//
// Every function takes the caller's tenant transaction — org context (the RLS
// GUC in multi mode) exists only inside it, so nothing here opens connections.

import { sql } from 'kysely'
import type { RawBuilder, Selectable, Transaction } from 'kysely'
import { z } from 'zod'
import type { Database } from '#core/server/database/schema'
import type { TenantContext } from '#tenant/server'
import type { RecordsAttachmentValue, RecordsConnectedRecord, RecordsLinkValue, RecordsRefValue } from '#records'
import { createNotification } from '#core/server/utils/notifications'
import {
  getRecordsRefSource,
  getRecordsStorageDriver,
  getRegisteredRecordTypes,
  runRecordsClosingHooks,
  runRecordsFieldFilters,
  type RecordsFieldPatch,
  type RecordsListPatch,
  type RecordsRefTarget
} from './records-registry'
import { getRecordType, getRecordTypeFields, recordsAccessGrantingKeys, recordsStatusDefault, type RecordsFieldSetting } from './definition-settings'
import { normalizeChannelValue } from './normalize'
import { recordRecordsActivity } from './records-activity'
import { closingRulesOf, enforceClosingRules } from './closing'
import { visibleRecordIds } from './list-records'
import { requireShareConfirmation, type RecordsSharingMode } from './share-confirmation'
import { applyAttachmentsPatch, listRecordAttachments } from './attachments'

type Tx = Transaction<Database>

export type RecordRow = Selectable<Database['records_entries']>

export interface RecordsHydratedRecord {
  id: string
  recordType: string
  name: string
  status: string | null
  createdBy: string
  createdAt: Date
  updatedAt: Date
  /** The linked user account, whose name and email addresses the record shows. */
  userId: string | null
  /** Logical field values keyed by field key (shapes per InferRecordShape). */
  fields: Record<string, unknown>
}

const uuidSchema = z.string().uuid()

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

function emptyValueFor(def: RecordsFieldSetting): unknown {
  switch (def.storage) {
    case 'entries':
    case 'connections':
    case 'channels':
    case 'attachments':
      return []
    case 'user_refs':
      return def.multiple ? [] : null
    default:
      return null
  }
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value)
}

// Field keys (on any registered type) whose connection rows surface in
// reverse under `fieldKey` of `typeKey` records: every field declared with
// `target: typeKey, reverseKey: fieldKey`. Connection rows store only the
// writing side's field_key, so a key shared by two types pointing at
// different targets would be ambiguous — field keys are expected to be
// distinct across connection vocabularies.
function connectionReverseSources(typeKey: string, fieldKey: string): string[] {
  const sources = new Set<string>()
  for (const manifest of getRegisteredRecordTypes()) {
    for (const [key, def] of Object.entries(manifest.fields)) {
      if (def.kind === 'connection' && def.target === typeKey && def.reverseKey === fieldKey) {
        sources.add(key)
      }
    }
  }
  return [...sources]
}

export async function hydrateRecords(
  tx: Tx,
  ctx: TenantContext,
  typeKey: string,
  rows: RecordRow[]
): Promise<RecordsHydratedRecord[]> {
  if (rows.length === 0) return []

  // Stale orphan rows describe nothing readable; real fields only.
  const defs = (await getRecordTypeFields(tx, typeKey)).filter(d => !d.orphan)
  const defsByKey = new Map(defs.map(d => [d.key, d]))
  const ids = rows.map(r => r.id)

  // Records saved before their type had a status read as its default.
  const statusDefault = recordsStatusDefault(defs)
  const out = new Map<string, RecordsHydratedRecord>()
  for (const row of rows) {
    const status = row.status ?? statusDefault
    const fields: Record<string, unknown> = {}
    for (const def of defs) fields[def.key] = emptyValueFor(def)
    for (const def of defs) {
      if (def.storage === 'promoted') {
        fields[def.key] = def.column === 'name' ? row.name : status
      } else if (def.storage === 'jsonb') {
        fields[def.key] = (row.data as Record<string, unknown>)[def.key] ?? null
      }
    }
    out.set(row.id, {
      id: row.id,
      recordType: row.record_type,
      name: row.name,
      status,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      userId: row.user_id ?? null,
      fields
    })
  }

  const entryKeys = defs.filter(d => d.storage === 'entries').map(d => d.key)
  if (entryKeys.length > 0) {
    const entryRows = await tx
      .selectFrom('records_field_entries')
      .select(['record_id', 'field_key', 'payload', 'normalized_value'])
      .where('record_id', 'in', ids)
      .where('field_key', 'in', entryKeys)
      .orderBy('sort_order', 'asc')
      .execute()
    for (const e of entryRows) {
      const def = defsByKey.get(e.field_key)
      const rec = out.get(e.record_id)
      if (!def || !rec) continue
      const payload = e.payload as Record<string, unknown>
      const list = rec.fields[e.field_key] as unknown[]
      if (def.kind === 'link') {
        const link: RecordsLinkValue = { url: String(payload.url ?? e.normalized_value ?? '') }
        if (payload.label) link.label = String(payload.label)
        list.push(link)
      } else {
        list.push(String(payload.value ?? e.normalized_value ?? ''))
      }
    }
  }

  const userRefKeys = defs.filter(d => d.storage === 'user_refs').map(d => d.key)
  if (userRefKeys.length > 0) {
    const refRows = await tx
      .selectFrom('records_user_refs')
      .select(['record_id', 'field_key', 'user_id'])
      .where('record_id', 'in', ids)
      .where('field_key', 'in', userRefKeys)
      .orderBy('created_at', 'asc')
      .execute()
    for (const r of refRows) {
      const def = defsByKey.get(r.field_key)
      const rec = out.get(r.record_id)
      if (!def || !rec) continue
      if (def.multiple) {
        (rec.fields[r.field_key] as string[]).push(r.user_id)
      } else if (rec.fields[r.field_key] == null) {
        rec.fields[r.field_key] = r.user_id
      }
    }
  }

  const connDefs = defs.filter(d => d.storage === 'connections')
  if (connDefs.length > 0) {
    const forward = await tx
      .selectFrom('records_connections')
      .select(['from_record_id', 'to_record_id', 'field_key'])
      .where('from_record_id', 'in', ids)
      .where('field_key', 'in', connDefs.map(d => d.key))
      .execute()
    for (const c of forward) {
      const rec = out.get(c.from_record_id)
      if (rec) pushUnique(rec.fields[c.field_key] as string[], c.to_record_id)
    }
    // Reverse reads: rows written from the other side surface under the field
    // their writer's def named via reverseKey.
    const reverseMap = new Map<string, string[]>()
    for (const def of connDefs) {
      for (const source of connectionReverseSources(typeKey, def.key)) {
        const targets = reverseMap.get(source) ?? []
        targets.push(def.key)
        reverseMap.set(source, targets)
      }
    }
    if (reverseMap.size > 0) {
      const reverse = await tx
        .selectFrom('records_connections')
        .select(['from_record_id', 'to_record_id', 'field_key'])
        .where('to_record_id', 'in', ids)
        .where('field_key', 'in', [...reverseMap.keys()])
        .execute()
      for (const c of reverse) {
        const rec = out.get(c.to_record_id)
        if (!rec) continue
        for (const ourKey of reverseMap.get(c.field_key) ?? []) {
          pushUnique(rec.fields[ourKey] as string[], c.from_record_id)
        }
      }
    }
    // Connection values surface as { id, name } so pickers and panels render
    // linked records without per-record lookups — one batched name query
    // covers every edge on the page. Records the caller can't open keep their
    // id (so a full-list edit doesn't drop the edge) but not their name.
    const connectedIds = new Set<string>()
    for (const rec of out.values()) {
      for (const def of connDefs) {
        for (const id of rec.fields[def.key] as string[]) connectedIds.add(id)
      }
    }
    const connectedNames = new Map<string, string>()
    const visible = await visibleRecordIds(tx, ctx, [...connectedIds])
    if (visible.size > 0) {
      const nameRows = await tx
        .selectFrom('records_entries')
        .select(['id', 'name'])
        .where('id', 'in', [...visible])
        .execute()
      for (const r of nameRows) connectedNames.set(r.id, r.name)
    }
    for (const rec of out.values()) {
      for (const def of connDefs) {
        rec.fields[def.key] = (rec.fields[def.key] as string[]).map(
          (id): RecordsConnectedRecord => visible.has(id)
            ? { id, name: connectedNames.get(id) ?? id }
            : { id, name: '', hidden: true }
        )
      }
    }
  }

  const refDefs = defs.filter(d => d.kind === 'ref')
  if (refDefs.length > 0) await hydrateRefs(tx, ctx, refDefs, [...out.values()])

  const attachmentKeys = defs.filter(d => d.storage === 'attachments').map(d => d.key)
  if (attachmentKeys.length > 0) {
    const files = await listRecordAttachments(tx, ids, attachmentKeys)
    for (const [recordId, byField] of files) {
      const rec = out.get(recordId)
      if (!rec) continue
      for (const [fieldKey, list] of byField) rec.fields[fieldKey] = list
    }
  }

  const driverDefs = new Map<string, RecordsFieldSetting[]>()
  for (const def of defs) {
    if (def.storage !== 'channels') continue
    const list = driverDefs.get(def.storage) ?? []
    list.push(def)
    driverDefs.set(def.storage, list)
  }
  for (const [storage, storageDefs] of driverDefs) {
    const driver = getRecordsStorageDriver(storage)
    if (!driver) continue
    const values = await driver.hydrate(tx, storageDefs, ids)
    for (const [recordId, byField] of values) {
      const rec = out.get(recordId)
      if (!rec) continue
      for (const [fieldKey, list] of byField) rec.fields[fieldKey] = list
    }
  }

  return rows.map(r => out.get(r.id)!)
}

// A ref's stored id becomes { id, label, url } through its source, one
// resolve call per source for the whole page. Targets the caller can't see,
// and ones that no longer exist, keep their id but not their label.
async function hydrateRefs(
  tx: Tx,
  ctx: TenantContext,
  refDefs: RecordsFieldSetting[],
  records: RecordsHydratedRecord[]
): Promise<void> {
  const idsBySource = new Map<string, Set<string>>()
  for (const def of refDefs) {
    if (!def.source) continue
    const ids = idsBySource.get(def.source) ?? new Set<string>()
    for (const rec of records) {
      const id = rec.fields[def.key]
      if (typeof id === 'string') ids.add(id)
    }
    idsBySource.set(def.source, ids)
  }
  const resolved = new Map<string, Map<string, RecordsRefTarget | 'hidden'>>()
  for (const [sourceKey, ids] of idsBySource) {
    const source = getRecordsRefSource(sourceKey)
    resolved.set(sourceKey, source && ids.size > 0 ? await source.resolve(tx, ctx, [...ids]) : new Map())
  }
  for (const def of refDefs) {
    const targets = def.source ? resolved.get(def.source) : undefined
    for (const rec of records) {
      const id = rec.fields[def.key]
      if (typeof id !== 'string') {
        rec.fields[def.key] = null
        continue
      }
      const target = targets?.get(id)
      let value: RecordsRefValue
      if (target === undefined) value = { id, label: '', missing: true }
      else if (target === 'hidden') value = { id, label: '', hidden: true }
      else value = target.url ? { id, label: target.label, url: target.url } : { id, label: target.label }
      rec.fields[def.key] = value
    }
  }
}

export async function getRecord(
  tx: Tx,
  ctx: TenantContext,
  typeKey: string,
  id: string
): Promise<RecordsHydratedRecord> {
  if (!uuidSchema.safeParse(id).success) {
    throw createError({ statusCode: 404, statusMessage: 'Record not found.' })
  }
  const row = await tx
    .selectFrom('records_entries')
    .selectAll()
    .where('id', '=', id)
    .where('record_type', '=', typeKey)
    .executeTakeFirst()
  if (!row) {
    throw createError({ statusCode: 404, statusMessage: 'Record not found.' })
  }
  const [hydrated] = await hydrateRecords(tx, ctx, typeKey, [row])
  return hydrated!
}

// Hard delete. Satellite rows (field entries, user refs, connections, shares,
// driver-backed links, activity, comments) ride along via ON DELETE CASCADE —
// the record-keyed timeline disappears with the record, so no activity row is
// written.
export async function deleteRecord(
  tx: Tx,
  ctx: TenantContext,
  typeKey: string,
  id: string
): Promise<void> {
  if (!uuidSchema.safeParse(id).success) {
    throw createError({ statusCode: 404, statusMessage: 'Record not found.' })
  }
  const result = await tx
    .deleteFrom('records_entries')
    .where('id', '=', id)
    .where('record_type', '=', typeKey)
    .executeTakeFirst()
  if (Number(result.numDeletedRows) === 0) {
    throw createError({ statusCode: 404, statusMessage: 'Record not found.' })
  }
}

// ---------------------------------------------------------------------------
// Patch parsing + validation
// ---------------------------------------------------------------------------

type ParsedList = RecordsListPatch

// D.T-style value-list body for multi-value storages:
//   { values: [{ value, delete? }], force_values? }
// `force_values` replaces the whole list with the non-delete items.
const valueListSchema = z.object({
  values: z.array(z.object({
    value: z.unknown().optional(),
    delete: z.boolean().optional(),
    primary: z.boolean().optional(),
    label: z.string().nullable().optional(),
    linkId: z.string().uuid().optional()
  })),
  force_values: z.boolean().optional()
})

function badValue(def: RecordsFieldSetting, message: string): never {
  throw createError({ statusCode: 400, statusMessage: `${def.key}: ${message}` })
}

function requireOptionKey(def: RecordsFieldSetting, value: unknown): string {
  const parsed = z.string().safeParse(value)
  if (!parsed.success) badValue(def, 'expected an option key')
  const options = def.options
  if (options && Object.keys(options).length > 0) {
    const option = options[parsed.data]
    if (!option || option.deleted) badValue(def, `'${parsed.data}' is not an available option`)
  }
  return parsed.data
}

function requireNonEmptyString(def: RecordsFieldSetting, value: unknown): string {
  const parsed = z.string().safeParse(value)
  if (!parsed.success || parsed.data.trim() === '') badValue(def, 'expected a non-empty string')
  return parsed.data
}

function requireUuid(def: RecordsFieldSetting, value: unknown): string {
  const parsed = uuidSchema.safeParse(value)
  if (!parsed.success) badValue(def, 'expected an id')
  return parsed.data
}

// Accepts `{ url, label? }` or a bare url string.
function coerceLinkValue(def: RecordsFieldSetting, value: unknown): RecordsLinkValue {
  const raw = typeof value === 'string' ? { url: value } : value
  const parsed = z.object({ url: z.string(), label: z.string().optional() }).safeParse(raw)
  if (!parsed.success) badValue(def, 'expected { url, label? }')
  if (!normalizeChannelValue('url', parsed.data.url).valid) badValue(def, 'invalid url')
  return parsed.data
}

function validateScalar(def: RecordsFieldSetting, raw: unknown): unknown {
  if (raw === null) {
    if (def.column === 'name') badValue(def, 'cannot be empty')
    return null
  }
  switch (def.kind) {
    case 'text':
    case 'textarea': {
      const parsed = z.string().safeParse(raw)
      if (!parsed.success) badValue(def, 'expected a string')
      if (def.column === 'name' && parsed.data.trim() === '') badValue(def, 'cannot be empty')
      return parsed.data
    }
    case 'number': {
      const parsed = z.number().finite().safeParse(raw)
      if (!parsed.success) badValue(def, 'expected a number')
      return parsed.data
    }
    case 'boolean': {
      const parsed = z.boolean().safeParse(raw)
      if (!parsed.success) badValue(def, 'expected a boolean')
      return parsed.data
    }
    case 'date':
    case 'datetime': {
      const parsed = z.string().safeParse(raw)
      if (!parsed.success || Number.isNaN(Date.parse(parsed.data))) badValue(def, 'expected a date string')
      return parsed.data
    }
    case 'key_select':
      return requireOptionKey(def, raw)
    case 'ref':
      // An id, or a ref as hydrated ({ id, label, ... }).
      return requireUuid(def, raw !== null && typeof raw === 'object' ? (raw as { id?: unknown }).id : raw)
    default:
      badValue(def, `kind '${def.kind}' does not accept a scalar value`)
  }
}

function parseValueList(def: RecordsFieldSetting, raw: unknown): ParsedList {
  // Shorthands: a plain array replaces the whole list; a single user_select
  // additionally accepts a bare user id or null.
  if (Array.isArray(raw)) {
    return { items: raw.map(value => ({ value, delete: false })), force: true }
  }
  if (def.storage === 'user_refs' && !def.multiple && (raw === null || typeof raw === 'string')) {
    return { items: raw === null ? [] : [{ value: raw, delete: false }], force: true }
  }
  const parsed = valueListSchema.safeParse(raw)
  if (!parsed.success) badValue(def, 'expected { values: [...] } or an array')
  return {
    items: parsed.data.values.map(v => ({
      value: v.value,
      delete: v.delete === true,
      primary: v.primary,
      label: v.label ?? null,
      linkId: v.linkId
    })),
    force: parsed.data.force_values === true
  }
}

function validateListItems(def: RecordsFieldSetting, list: ParsedList): void {
  if (def.storage === 'channels') {
    const driver = getRecordsStorageDriver(def.storage)
    if (!driver) badValue(def, `no storage driver for ${def.kind} fields`)
    for (const item of list.items) driver.validateItem(def, item)
    return
  }
  for (const item of list.items) {
    switch (def.kind) {
      case 'multi_select':
        item.value = requireOptionKey(def, item.value)
        break
      case 'tags':
        item.value = requireNonEmptyString(def, item.value)
        break
      case 'link':
        item.value = coerceLinkValue(def, item.value)
        break
      case 'user_select':
      case 'connection':
        item.value = requireUuid(def, item.value)
        break
      case 'attachments':
        // A file as hydrated ({ id, name, ... }) or its bare id.
        item.value = requireUuid(def, item.value !== null && typeof item.value === 'object'
          ? (item.value as { id?: unknown }).id
          : item.value)
        break
      default:
        badValue(def, `kind '${def.kind}' does not accept a value list`)
    }
  }
}

// ---------------------------------------------------------------------------
// Storage-routed writes
// ---------------------------------------------------------------------------

function entryNormalized(def: RecordsFieldSetting, value: unknown): string {
  if (def.kind === 'link') {
    return normalizeChannelValue('url', (value as RecordsLinkValue).url).normalized
  }
  return String(value).trim()
}

function entryPayload(def: RecordsFieldSetting, value: unknown): Record<string, unknown> {
  if (def.kind === 'link') {
    const link = value as RecordsLinkValue
    return link.label ? { url: link.url, label: link.label } : { url: link.url }
  }
  return { value: String(value).trim() }
}

async function applyEntriesOp(tx: Tx, recordId: string, def: RecordsFieldSetting, list: ParsedList): Promise<void> {
  if (list.force) {
    await tx
      .deleteFrom('records_field_entries')
      .where('record_id', '=', recordId)
      .where('field_key', '=', def.key)
      .execute()
  } else {
    const removeNorms = list.items.filter(i => i.delete).map(i => entryNormalized(def, i.value))
    if (removeNorms.length > 0) {
      await tx
        .deleteFrom('records_field_entries')
        .where('record_id', '=', recordId)
        .where('field_key', '=', def.key)
        .where('normalized_value', 'in', removeNorms)
        .execute()
    }
  }
  const adds = list.items.filter(i => !i.delete)
  if (adds.length === 0) return
  const maxRow = await tx
    .selectFrom('records_field_entries')
    .select(({ fn }) => fn.max('sort_order').as('max'))
    .where('record_id', '=', recordId)
    .where('field_key', '=', def.key)
    .executeTakeFirst()
  const base = (maxRow?.max ?? -1) + 1
  await tx
    .insertInto('records_field_entries')
    .values(adds.map((item, i) => ({
      record_id: recordId,
      field_key: def.key,
      payload: sql<Record<string, unknown>>`${JSON.stringify(entryPayload(def, item.value))}::text::jsonb`,
      normalized_value: entryNormalized(def, item.value),
      sort_order: base + i
    })))
    // Bare target: the partial unique (record_id, field_key,
    // normalized_value) makes re-adding an existing value a no-op.
    .onConflict(oc => oc.doNothing())
    .execute()
}

async function applyUserRefsOp(
  tx: Tx,
  ctx: TenantContext,
  recordId: string,
  def: RecordsFieldSetting,
  list: ParsedList
): Promise<void> {
  if (list.force) {
    await tx
      .deleteFrom('records_user_refs')
      .where('record_id', '=', recordId)
      .where('field_key', '=', def.key)
      .execute()
  } else {
    const removeIds = list.items.filter(i => i.delete).map(i => String(i.value))
    if (removeIds.length > 0) {
      await tx
        .deleteFrom('records_user_refs')
        .where('record_id', '=', recordId)
        .where('field_key', '=', def.key)
        .where('user_id', 'in', removeIds)
        .execute()
    }
  }
  let adds = [...new Set(list.items.filter(i => !i.delete).map(i => String(i.value)))]
  if (!def.multiple && adds.length > 0) {
    // A single user_select holds at most one ref: replace, don't accumulate.
    adds = adds.slice(-1)
    if (!list.force) {
      await tx
        .deleteFrom('records_user_refs')
        .where('record_id', '=', recordId)
        .where('field_key', '=', def.key)
        .execute()
    }
  }
  if (adds.length === 0) return
  await tx
    .insertInto('records_user_refs')
    .values(adds.map(userId => ({
      record_id: recordId,
      field_key: def.key,
      user_id: userId,
      created_by: ctx.userId
    })))
    .onConflict(oc => oc.doNothing())
    .execute()
}

async function applyConnectionsOp(
  tx: Tx,
  typeKey: string,
  recordId: string,
  def: RecordsFieldSetting,
  list: ParsedList
): Promise<void> {
  // Rows surfaced in reverse under this field belong to the other side —
  // deletes must reach them too, or the UI could never remove them.
  const reverseSources = connectionReverseSources(typeKey, def.key)
  if (list.force) {
    await tx
      .deleteFrom('records_connections')
      .where('from_record_id', '=', recordId)
      .where('field_key', '=', def.key)
      .execute()
    if (reverseSources.length > 0) {
      await tx
        .deleteFrom('records_connections')
        .where('to_record_id', '=', recordId)
        .where('field_key', 'in', reverseSources)
        .execute()
    }
  } else {
    const removeIds = list.items.filter(i => i.delete).map(i => String(i.value))
    if (removeIds.length > 0) {
      await tx
        .deleteFrom('records_connections')
        .where('from_record_id', '=', recordId)
        .where('field_key', '=', def.key)
        .where('to_record_id', 'in', removeIds)
        .execute()
      if (reverseSources.length > 0) {
        await tx
          .deleteFrom('records_connections')
          .where('to_record_id', '=', recordId)
          .where('field_key', 'in', reverseSources)
          .where('from_record_id', 'in', removeIds)
          .execute()
      }
    }
  }
  const adds = [...new Set(list.items.filter(i => !i.delete).map(i => String(i.value)))]
  if (adds.length === 0) return
  await tx
    .insertInto('records_connections')
    .values(adds.map(toId => ({
      from_record_id: recordId,
      field_key: def.key,
      to_record_id: toId
    })))
    .onConflict(oc => oc.doNothing())
    .execute()
}

// Removals first, then the merge, so a key that is both nulled and re-set in
// one patch cannot happen (a key appears once per patch object anyway).
function dataMergeExpr(sets: Record<string, unknown>, removes: string[]): RawBuilder<Record<string, unknown>> {
  let expr = sql`data`
  for (const key of removes) {
    expr = sql`(${expr} - ${key}::text)`
  }
  if (Object.keys(sets).length > 0) {
    // ::text::jsonb — bind as plain text so the driver can't JSON-encode the
    // stringified object a second time; Postgres parses it into an object.
    expr = sql`(${expr} || ${JSON.stringify(sets)}::text::jsonb)`
  }
  return expr as RawBuilder<Record<string, unknown>>
}

// FK violations surface as opaque 500s; pre-checking turns bad references
// into clean 400s.
async function assertUsersExist(
  tx: Tx,
  defsByKey: Map<string, RecordsFieldSetting>,
  listOps: Map<string, ParsedList>
): Promise<void> {
  const userIds = new Set<string>()
  for (const [key, list] of listOps) {
    if (defsByKey.get(key)?.storage !== 'user_refs') continue
    for (const item of list.items) {
      if (!item.delete) userIds.add(String(item.value))
    }
  }
  if (userIds.size === 0) return
  const rows = await tx
    .selectFrom('users')
    .select('id')
    .where('id', 'in', [...userIds])
    .execute()
  const found = new Set(rows.map(r => r.id))
  const missing = [...userIds].find(id => !found.has(id))
  if (missing) {
    throw createError({ statusCode: 400, statusMessage: `Unknown user: ${missing}` })
  }
}

async function assertConnectionTargetsExist(
  tx: Tx,
  defsByKey: Map<string, RecordsFieldSetting>,
  listOps: Map<string, ParsedList>
): Promise<void> {
  for (const [key, list] of listOps) {
    const def = defsByKey.get(key)
    if (def?.storage !== 'connections') continue
    if (!def.target) {
      throw createError({ statusCode: 400, statusMessage: `${key}: no connection target configured` })
    }
    const ids = [...new Set(list.items.filter(i => !i.delete).map(i => String(i.value)))]
    if (ids.length === 0) continue
    const rows = await tx
      .selectFrom('records_entries')
      .select('id')
      .where('id', 'in', ids)
      .where('record_type', '=', def.target)
      .execute()
    const found = new Set(rows.map(r => r.id))
    const missing = ids.find(id => !found.has(id))
    if (missing) {
      throw createError({ statusCode: 400, statusMessage: `${key}: no ${def.target} record with id ${missing}` })
    }
  }
}

// A ref may only point at a target the caller can see. A value the record
// already holds is left alone, so editing other fields never fails on a ref
// the caller has since lost sight of.
async function assertRefTargets(
  tx: Tx,
  ctx: TenantContext,
  defsByKey: Map<string, RecordsFieldSetting>,
  scalarOps: Map<string, unknown>,
  old: RecordsHydratedRecord | null
): Promise<void> {
  for (const [key, value] of scalarOps) {
    const def = defsByKey.get(key)
    if (def?.kind !== 'ref' || typeof value !== 'string') continue
    if ((old?.fields[key] as RecordsRefValue | null | undefined)?.id === value) continue
    const source = def.source ? getRecordsRefSource(def.source) : undefined
    if (!source) badValue(def, 'no ref source is registered for this field')
    const target = (await source.resolve(tx, ctx, [value])).get(value)
    if (!target || target === 'hidden') badValue(def, `no ${source.label.toLowerCase()} with id ${value}`)
  }
}

function userIdsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String)
  return typeof value === 'string' ? [value] : []
}

// Tells the people a write newly names in an access-granting field (a task's
// assignee) that the record is now theirs, in the app and by email. The
// writer is never told about their own change.
async function notifyNewAssignees(
  tx: Tx,
  ctx: TenantContext,
  type: { key: string, labelSingular: string, app?: string },
  record: RecordsHydratedRecord,
  old: RecordsHydratedRecord | null,
  grantKeys: string[]
): Promise<void> {
  const added = new Set<string>()
  for (const key of grantKeys) {
    const before = new Set(userIdsOf(old?.fields[key]))
    for (const id of userIdsOf(record.fields[key])) {
      if (!before.has(id) && id !== ctx.userId) added.add(id)
    }
  }
  if (added.size === 0) return
  const actor = await tx.selectFrom('users').select('display_name').where('id', '=', ctx.userId).executeTakeFirst()
  const noun = type.labelSingular.toLowerCase()
  const article = /^[aeiou]/.test(noun) ? 'an' : 'a'
  await createNotification(tx, [...added].map(userId => ({
    userId,
    appId: type.app ?? 'records',
    title: `${actor?.display_name || 'Someone'} assigned you ${article} ${noun}`,
    body: record.name,
    icon: 'i-lucide-user-check',
    link: `/records/${type.key}/${record.id}`,
    actorId: ctx.userId,
    email: 'immediate' as const
  })))
}

// ---------------------------------------------------------------------------
// applyFieldPatch
// ---------------------------------------------------------------------------

// Activity keeps a file's id and name, not its time-limited link.
export function activityValue(def: Pick<RecordsFieldSetting, 'storage'>, value: unknown): unknown {
  if (def.storage !== 'attachments' || !Array.isArray(value)) return value
  return (value as RecordsAttachmentValue[]).map(f => ({ id: f.id, name: f.name }))
}

export interface ApplyFieldPatchOpts {
  /**
   * Set by writes a person makes: 'ask' refuses (409) a patch that names
   * someone in an access-granting people field who can't otherwise see the
   * record, until resent as 'confirmed'. Absent for system writes. A person's
   * write also notifies whoever it newly names in such a field.
   */
  sharing?: RecordsSharingMode
}

// One pipeline for create (recordId null) and update. Returns the record as
// hydrated after the patch.
export async function applyFieldPatch(
  tx: Tx,
  ctx: TenantContext,
  typeKey: string,
  recordId: string | null,
  patch: RecordsFieldPatch,
  opts: ApplyFieldPatchOpts = {}
): Promise<RecordsHydratedRecord> {
  const type = await getRecordType(tx, typeKey)
  if (!type || type.orphan) {
    throw createError({ statusCode: 404, statusMessage: `Unknown record type: ${typeKey}` })
  }

  const defs = await getRecordTypeFields(tx, typeKey)
  const defsByKey = new Map(defs.map(d => [d.key, d]))
  const isCreate = recordId === null

  let effective = await runRecordsFieldFilters(isCreate ? 'create' : 'update', patch, ctx, typeKey)

  // On create, code-declared defaults fill in for keys the patch doesn't set
  // (scalar storages only — list kinds have no meaningful default shape).
  if (isCreate) {
    effective = { ...effective }
    for (const def of defs) {
      if (def.default === undefined || def.orphan) continue
      if ((def.storage === 'promoted' || def.storage === 'jsonb') && !(def.key in effective)) {
        effective[def.key] = def.default
      }
    }
  }

  // Validate and route every patched field.
  const scalarOps = new Map<string, unknown>()
  const listOps = new Map<string, ParsedList>()
  for (const [key, raw] of Object.entries(effective)) {
    const def = defsByKey.get(key)
    if (!def || def.orphan) {
      throw createError({ statusCode: 400, statusMessage: `Unknown field: ${key}` })
    }
    if (def.storage === 'promoted' || def.storage === 'jsonb') {
      scalarOps.set(key, validateScalar(def, raw))
    } else {
      const list = parseValueList(def, raw)
      validateListItems(def, list)
      listOps.set(key, list)
    }
  }

  if (isCreate) {
    for (const def of defs) {
      // Files arrive by upload once the record exists, so they can't be required to create it.
      if (!def.required || def.orphan || def.storage === 'attachments') continue
      if (def.storage === 'promoted' || def.storage === 'jsonb') {
        const value = scalarOps.get(def.key)
        if (value == null || value === '') {
          throw createError({ statusCode: 400, statusMessage: `${def.key} is required` })
        }
      } else {
        const list = listOps.get(def.key)
        if (!list || !list.items.some(i => !i.delete)) {
          throw createError({ statusCode: 400, statusMessage: `${def.key} is required` })
        }
      }
    }
  }

  await assertUsersExist(tx, defsByKey, listOps)
  await assertConnectionTargetsExist(tx, defsByKey, listOps)

  let id: string
  let oldRecord: RecordsHydratedRecord | null = null
  const closingRules = closingRulesOf(type, defs)
  let closing = { closes: false }

  if (isCreate) {
    closing = enforceClosingRules(closingRules, scalarOps, null)
    await assertRefTargets(tx, ctx, defsByKey, scalarOps, null)
    const nameDef = defs.find(d => d.column === 'name')
    const statusDef = defs.find(d => d.column === 'status')
    const name = nameDef ? scalarOps.get(nameDef.key) : undefined
    if (typeof name !== 'string' || name.trim() === '') {
      throw createError({ statusCode: 400, statusMessage: 'A name is required to create a record.' })
    }
    const status = statusDef ? (scalarOps.get(statusDef.key) as string | null | undefined) : undefined
    const data: Record<string, unknown> = {}
    for (const [key, value] of scalarOps) {
      if (defsByKey.get(key)!.storage === 'jsonb' && value !== null) data[key] = value
    }
    const row = await tx
      .insertInto('records_entries')
      .values({
        record_type: typeKey,
        name: name.trim(),
        status: status ?? null,
        data: sql<Record<string, unknown>>`${JSON.stringify(data)}::text::jsonb`,
        created_by: ctx.userId
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    id = row.id
  } else {
    id = recordId
    // 404s when missing; also the pre-patch snapshot activity diffs against.
    oldRecord = await getRecord(tx, ctx, typeKey, id)

    if (scalarOps.size === 0 && listOps.size === 0) return oldRecord
    closing = enforceClosingRules(closingRules, scalarOps, oldRecord.fields)
    await assertRefTargets(tx, ctx, defsByKey, scalarOps, oldRecord)

    // Promoted columns, the jsonb merge, and the updated_at bump (no DB
    // trigger exists — the kernel owns it) in a single statement.
    let name: string | undefined
    let status: { value: string | null } | undefined
    const jsonbSets: Record<string, unknown> = {}
    const jsonbRemoves: string[] = []
    for (const [key, value] of scalarOps) {
      const def = defsByKey.get(key)!
      if (def.storage === 'promoted') {
        if (def.column === 'name') name = String(value).trim()
        else status = { value: value as string | null }
      } else if (value === null) {
        jsonbRemoves.push(key)
      } else {
        jsonbSets[key] = value
      }
    }
    const hasData = jsonbRemoves.length > 0 || Object.keys(jsonbSets).length > 0
    await tx
      .updateTable('records_entries')
      .set({
        ...(name !== undefined ? { name } : {}),
        ...(status !== undefined ? { status: status.value } : {}),
        ...(hasData ? { data: dataMergeExpr(jsonbSets, jsonbRemoves) } : {}),
        updated_at: sql`now()`
      })
      .where('id', '=', id)
      .execute()
  }

  for (const [key, list] of listOps) {
    const def = defsByKey.get(key)!
    switch (def.storage) {
      case 'entries':
        await applyEntriesOp(tx, id, def, list)
        break
      case 'user_refs':
        await applyUserRefsOp(tx, ctx, id, def, list)
        break
      case 'connections':
        await applyConnectionsOp(tx, typeKey, id, def, list)
        break
      case 'channels':
        await getRecordsStorageDriver(def.storage)!.apply(tx, ctx, id, def, list)
        break
      case 'attachments':
        await applyAttachmentsPatch(tx, id, def.key, list)
        break
    }
  }

  // Only a write to an access-granting people field can share the record.
  const grantKeys = recordsAccessGrantingKeys(typeKey)
  if (opts.sharing && [...listOps.keys()].some(key => grantKeys.includes(key))) {
    await requireShareConfirmation(tx, ctx, typeKey, id, oldRecord?.fields ?? null, opts.sharing)
  }

  const record = await getRecord(tx, ctx, typeKey, id)

  if (opts.sharing && [...listOps.keys()].some(key => grantKeys.includes(key))) {
    await notifyNewAssignees(tx, ctx, { key: typeKey, labelSingular: type.labelSingular, app: type.manifest?.app }, record, oldRecord, grantKeys)
  }

  if (isCreate) {
    await recordRecordsActivity(tx, ctx, id, 'created', { new: { name: record.name } })
  } else {
    for (const key of [...scalarOps.keys(), ...listOps.keys()]) {
      // Storage drivers write their own activity rows.
      if (defsByKey.get(key)!.storage === 'channels') continue
      const def = defsByKey.get(key)!
      const before = activityValue(def, oldRecord!.fields[key] ?? null)
      const after = activityValue(def, record.fields[key] ?? null)
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        await recordRecordsActivity(tx, ctx, id, 'field_changed', { fieldKey: key, old: before, new: after })
      }
    }
  }

  if (closing.closes) {
    const reason = closingRules.reasonKey ? (record.fields[closingRules.reasonKey] as string | null) : null
    const reasonOption = closingRules.reasonKey && reason
      ? defsByKey.get(closingRules.reasonKey)?.options?.[reason] ?? null
      : null
    await runRecordsClosingHooks(tx, ctx, { typeKey, recordId: id, reason, reasonOption })
  }

  return record
}
