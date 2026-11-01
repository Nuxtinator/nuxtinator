// Record hydration + the storage-routed field patch pipeline.
//
// A record's logical fields live in five physical homes (see `storageOf` in
// #crm): promoted columns on crm_records, keys in crm_records.data,
// crm_record_field_entries rows, crm_record_user_refs rows,
// crm_record_connections rows, and channel links. `hydrateRecords` reads them
// all back into one flat `fields` map (one query per storage class, batched
// over records); `applyFieldPatch` routes writes the other way:
//
//   merged defs → field-filter hook chain → per-kind validation →
//   closing rules (./closing) → storage-routed writes → updated_at bump →
//   activity rows per changed field → consent revocation on close
//
// Every function takes the caller's tenant transaction — org context (the RLS
// GUC in multi mode) exists only inside it, so nothing here opens connections.

import { sql } from 'kysely'
import type { RawBuilder, Selectable, Transaction } from 'kysely'
import { z } from 'zod'
import type { Database } from '#core/server/database/schema'
import type { TenantContext } from '#tenant/server'
import type { CrmChannelEntry, CrmConnectedRecord, CrmLinkValue } from '#crm'
import { getRegisteredRecordTypes, runCrmFieldFilters, type CrmFieldPatch } from './crm-registry'
import { getRecordType, getRecordTypeFields, type CrmFieldSetting } from './definition-settings'
import { normalizeChannelValue } from './normalize'
import { claimChannel, findChannel, linkChannel, unlinkChannel } from './channels'
import { recordCrmActivity } from './crm-activity'
import { closingRulesOf, enforceClosingRules, revokeConsentOnClose } from './closing'

type Tx = Transaction<Database>

export type CrmRecordRow = Selectable<Database['crm_records']>

export interface CrmHydratedRecord {
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

function emptyValueFor(def: CrmFieldSetting): unknown {
  switch (def.storage) {
    case 'entries':
    case 'connections':
    case 'channels':
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
  typeKey: string,
  rows: CrmRecordRow[]
): Promise<CrmHydratedRecord[]> {
  if (rows.length === 0) return []

  // Stale orphan rows describe nothing readable; real fields only.
  const defs = (await getRecordTypeFields(tx, typeKey)).filter(d => !d.orphan)
  const defsByKey = new Map(defs.map(d => [d.key, d]))
  const ids = rows.map(r => r.id)

  const out = new Map<string, CrmHydratedRecord>()
  for (const row of rows) {
    const fields: Record<string, unknown> = {}
    for (const def of defs) fields[def.key] = emptyValueFor(def)
    for (const def of defs) {
      if (def.storage === 'promoted') {
        fields[def.key] = def.column === 'name' ? row.name : row.status
      } else if (def.storage === 'jsonb') {
        fields[def.key] = (row.data as Record<string, unknown>)[def.key] ?? null
      }
    }
    out.set(row.id, {
      id: row.id,
      recordType: row.record_type,
      name: row.name,
      status: row.status,
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
      .selectFrom('crm_record_field_entries')
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
        const link: CrmLinkValue = { url: String(payload.url ?? e.normalized_value ?? '') }
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
      .selectFrom('crm_record_user_refs')
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
      .selectFrom('crm_record_connections')
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
        .selectFrom('crm_record_connections')
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
    // covers every edge on the page.
    const connectedIds = new Set<string>()
    for (const rec of out.values()) {
      for (const def of connDefs) {
        for (const id of rec.fields[def.key] as string[]) connectedIds.add(id)
      }
    }
    const connectedNames = new Map<string, string>()
    if (connectedIds.size > 0) {
      const nameRows = await tx
        .selectFrom('crm_records')
        .select(['id', 'name'])
        .where('id', 'in', [...connectedIds])
        .execute()
      for (const r of nameRows) connectedNames.set(r.id, r.name)
    }
    for (const rec of out.values()) {
      for (const def of connDefs) {
        rec.fields[def.key] = (rec.fields[def.key] as string[]).map(
          (id): CrmConnectedRecord => ({ id, name: connectedNames.get(id) ?? id })
        )
      }
    }
  }

  const channelKeys = defs.filter(d => d.storage === 'channels').map(d => d.key)
  if (channelKeys.length > 0) {
    const chanRows = await tx
      .selectFrom('crm_contact_channels as cc')
      .innerJoin('crm_channels as ch', 'ch.id', 'cc.channel_id')
      .select([
        'cc.id as link_id',
        'cc.record_id as record_id',
        'cc.field_key as field_key',
        'cc.channel_id as channel_id',
        'cc.label as label',
        'cc.is_primary as is_primary',
        'ch.channel_type as channel_type',
        'ch.value as value',
        'ch.verified as verified'
      ])
      .where('cc.record_id', 'in', ids)
      .where('cc.field_key', 'in', channelKeys)
      .orderBy('cc.sort_order', 'asc')
      .execute()
    for (const c of chanRows) {
      const rec = out.get(c.record_id)
      if (!rec) continue
      const entry: CrmChannelEntry = {
        linkId: c.link_id,
        channelId: c.channel_id,
        channelType: c.channel_type,
        value: c.value,
        label: c.label,
        isPrimary: c.is_primary,
        verified: c.verified
      }
      ;(rec.fields[c.field_key] as CrmChannelEntry[]).push(entry)
    }
  }

  return rows.map(r => out.get(r.id)!)
}

export async function getRecord(
  tx: Tx,
  _ctx: TenantContext,
  typeKey: string,
  id: string
): Promise<CrmHydratedRecord> {
  if (!uuidSchema.safeParse(id).success) {
    throw createError({ statusCode: 404, statusMessage: 'Record not found.' })
  }
  const row = await tx
    .selectFrom('crm_records')
    .selectAll()
    .where('id', '=', id)
    .where('record_type', '=', typeKey)
    .executeTakeFirst()
  if (!row) {
    throw createError({ statusCode: 404, statusMessage: 'Record not found.' })
  }
  const [hydrated] = await hydrateRecords(tx, typeKey, [row])
  return hydrated!
}

// Hard delete. Satellite rows (field entries, user refs, connections, shares,
// channel links, activity, comments) ride along via ON DELETE CASCADE — the
// record-keyed timeline disappears with the record, so no activity row is
// written. Channel identity rows (crm_channels) survive because consent and
// suppression state hang off them.
export async function deleteRecord(
  tx: Tx,
  _ctx: TenantContext,
  typeKey: string,
  id: string
): Promise<void> {
  if (!uuidSchema.safeParse(id).success) {
    throw createError({ statusCode: 404, statusMessage: 'Record not found.' })
  }
  const result = await tx
    .deleteFrom('crm_records')
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

interface ParsedItem {
  value: unknown
  delete: boolean
  primary?: boolean
  label?: string | null
  linkId?: string
}

interface ParsedList {
  items: ParsedItem[]
  force: boolean
}

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

function badValue(def: CrmFieldSetting, message: string): never {
  throw createError({ statusCode: 400, statusMessage: `${def.key}: ${message}` })
}

function requireOptionKey(def: CrmFieldSetting, value: unknown): string {
  const parsed = z.string().safeParse(value)
  if (!parsed.success) badValue(def, 'expected an option key')
  const options = def.options
  if (options && Object.keys(options).length > 0) {
    const option = options[parsed.data]
    if (!option || option.deleted) badValue(def, `'${parsed.data}' is not an available option`)
  }
  return parsed.data
}

function requireNonEmptyString(def: CrmFieldSetting, value: unknown): string {
  const parsed = z.string().safeParse(value)
  if (!parsed.success || parsed.data.trim() === '') badValue(def, 'expected a non-empty string')
  return parsed.data
}

function requireUuid(def: CrmFieldSetting, value: unknown): string {
  const parsed = uuidSchema.safeParse(value)
  if (!parsed.success) badValue(def, 'expected an id')
  return parsed.data
}

// Accepts `{ url, label? }` or a bare url string.
function coerceLinkValue(def: CrmFieldSetting, value: unknown): CrmLinkValue {
  const raw = typeof value === 'string' ? { url: value } : value
  const parsed = z.object({ url: z.string(), label: z.string().optional() }).safeParse(raw)
  if (!parsed.success) badValue(def, 'expected { url, label? }')
  if (!normalizeChannelValue('url', parsed.data.url).valid) badValue(def, 'invalid url')
  return parsed.data
}

function validateScalar(def: CrmFieldSetting, raw: unknown): unknown {
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
    default:
      badValue(def, `kind '${def.kind}' does not accept a scalar value`)
  }
}

function parseValueList(def: CrmFieldSetting, raw: unknown): ParsedList {
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

function validateListItems(def: CrmFieldSetting, list: ParsedList): void {
  for (const item of list.items) {
    // A channel delete addressed by link id carries no value to validate.
    if (item.delete && def.storage === 'channels' && item.linkId) continue
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
      case 'communication_channel':
        item.value = requireNonEmptyString(def, item.value)
        break
      default:
        badValue(def, `kind '${def.kind}' does not accept a value list`)
    }
  }
}

// ---------------------------------------------------------------------------
// Storage-routed writes
// ---------------------------------------------------------------------------

function entryNormalized(def: CrmFieldSetting, value: unknown): string {
  if (def.kind === 'link') {
    return normalizeChannelValue('url', (value as CrmLinkValue).url).normalized
  }
  return String(value).trim()
}

function entryPayload(def: CrmFieldSetting, value: unknown): Record<string, unknown> {
  if (def.kind === 'link') {
    const link = value as CrmLinkValue
    return link.label ? { url: link.url, label: link.label } : { url: link.url }
  }
  return { value: String(value).trim() }
}

async function applyEntriesOp(tx: Tx, recordId: string, def: CrmFieldSetting, list: ParsedList): Promise<void> {
  if (list.force) {
    await tx
      .deleteFrom('crm_record_field_entries')
      .where('record_id', '=', recordId)
      .where('field_key', '=', def.key)
      .execute()
  } else {
    const removeNorms = list.items.filter(i => i.delete).map(i => entryNormalized(def, i.value))
    if (removeNorms.length > 0) {
      await tx
        .deleteFrom('crm_record_field_entries')
        .where('record_id', '=', recordId)
        .where('field_key', '=', def.key)
        .where('normalized_value', 'in', removeNorms)
        .execute()
    }
  }
  const adds = list.items.filter(i => !i.delete)
  if (adds.length === 0) return
  const maxRow = await tx
    .selectFrom('crm_record_field_entries')
    .select(({ fn }) => fn.max('sort_order').as('max'))
    .where('record_id', '=', recordId)
    .where('field_key', '=', def.key)
    .executeTakeFirst()
  const base = (maxRow?.max ?? -1) + 1
  await tx
    .insertInto('crm_record_field_entries')
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
  def: CrmFieldSetting,
  list: ParsedList
): Promise<void> {
  if (list.force) {
    await tx
      .deleteFrom('crm_record_user_refs')
      .where('record_id', '=', recordId)
      .where('field_key', '=', def.key)
      .execute()
  } else {
    const removeIds = list.items.filter(i => i.delete).map(i => String(i.value))
    if (removeIds.length > 0) {
      await tx
        .deleteFrom('crm_record_user_refs')
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
        .deleteFrom('crm_record_user_refs')
        .where('record_id', '=', recordId)
        .where('field_key', '=', def.key)
        .execute()
    }
  }
  if (adds.length === 0) return
  await tx
    .insertInto('crm_record_user_refs')
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
  def: CrmFieldSetting,
  list: ParsedList
): Promise<void> {
  // Rows surfaced in reverse under this field belong to the other side —
  // deletes must reach them too, or the UI could never remove them.
  const reverseSources = connectionReverseSources(typeKey, def.key)
  if (list.force) {
    await tx
      .deleteFrom('crm_record_connections')
      .where('from_record_id', '=', recordId)
      .where('field_key', '=', def.key)
      .execute()
    if (reverseSources.length > 0) {
      await tx
        .deleteFrom('crm_record_connections')
        .where('to_record_id', '=', recordId)
        .where('field_key', 'in', reverseSources)
        .execute()
    }
  } else {
    const removeIds = list.items.filter(i => i.delete).map(i => String(i.value))
    if (removeIds.length > 0) {
      await tx
        .deleteFrom('crm_record_connections')
        .where('from_record_id', '=', recordId)
        .where('field_key', '=', def.key)
        .where('to_record_id', 'in', removeIds)
        .execute()
      if (reverseSources.length > 0) {
        await tx
          .deleteFrom('crm_record_connections')
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
    .insertInto('crm_record_connections')
    .values(adds.map(toId => ({
      from_record_id: recordId,
      field_key: def.key,
      to_record_id: toId
    })))
    .onConflict(oc => oc.doNothing())
    .execute()
}

async function applyChannelsOp(
  tx: Tx,
  ctx: TenantContext,
  recordId: string,
  def: CrmFieldSetting,
  list: ParsedList
): Promise<void> {
  const channelType = def.channelType
  if (!channelType) {
    throw createError({ statusCode: 400, statusMessage: `${def.key}: no channel type configured` })
  }
  if (list.force) {
    const links = await tx
      .selectFrom('crm_contact_channels')
      .select('id')
      .where('record_id', '=', recordId)
      .where('field_key', '=', def.key)
      .execute()
    for (const link of links) {
      await unlinkChannel(tx, ctx, recordId, link.id)
    }
  }
  for (const item of list.items) {
    if (item.delete) {
      if (list.force) continue
      let linkId = item.linkId ?? null
      if (!linkId && typeof item.value === 'string') {
        const channel = await findChannel(tx, { channelType, value: item.value })
        if (channel) {
          const link = await tx
            .selectFrom('crm_contact_channels')
            .select('id')
            .where('record_id', '=', recordId)
            .where('field_key', '=', def.key)
            .where('channel_id', '=', channel.id)
            .executeTakeFirst()
          linkId = link?.id ?? null
        }
      }
      // Absent links are treated as already gone (idempotent deletes).
      if (linkId) await unlinkChannel(tx, ctx, recordId, linkId)
    } else {
      const channel = await claimChannel(tx, { channelType, value: String(item.value) })
      await linkChannel(tx, ctx, recordId, def.key, channel.id, {
        label: item.label ?? undefined,
        primary: item.primary
      })
    }
  }
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
  defsByKey: Map<string, CrmFieldSetting>,
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
  defsByKey: Map<string, CrmFieldSetting>,
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
      .selectFrom('crm_records')
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

// ---------------------------------------------------------------------------
// applyFieldPatch
// ---------------------------------------------------------------------------

// One pipeline for create (recordId null) and update. Returns the record as
// hydrated after the patch.
export async function applyFieldPatch(
  tx: Tx,
  ctx: TenantContext,
  typeKey: string,
  recordId: string | null,
  patch: CrmFieldPatch
): Promise<CrmHydratedRecord> {
  const type = await getRecordType(tx, typeKey)
  if (!type || type.orphan) {
    throw createError({ statusCode: 404, statusMessage: `Unknown record type: ${typeKey}` })
  }

  const defs = await getRecordTypeFields(tx, typeKey)
  const defsByKey = new Map(defs.map(d => [d.key, d]))
  const isCreate = recordId === null

  let effective = await runCrmFieldFilters(isCreate ? 'create' : 'update', patch, ctx, typeKey)

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
      if (!def.required || def.orphan) continue
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
  let oldRecord: CrmHydratedRecord | null = null
  const closingRules = closingRulesOf(type, defs)
  let closing = { revokeConsent: false }

  if (isCreate) {
    closing = enforceClosingRules(closingRules, scalarOps, null)
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
      .insertInto('crm_records')
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
      .updateTable('crm_records')
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
        await applyChannelsOp(tx, ctx, id, def, list)
        break
    }
  }

  const record = await getRecord(tx, ctx, typeKey, id)

  if (isCreate) {
    await recordCrmActivity(tx, ctx, id, 'created', { new: { name: record.name } })
  } else {
    for (const key of [...scalarOps.keys(), ...listOps.keys()]) {
      // Channel links/unlinks write their own activity rows.
      if (defsByKey.get(key)!.storage === 'channels') continue
      const before = oldRecord!.fields[key] ?? null
      const after = record.fields[key] ?? null
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        await recordCrmActivity(tx, ctx, id, 'field_changed', { fieldKey: key, old: before, new: after })
      }
    }
  }

  if (closing.revokeConsent && closingRules.reasonKey) {
    const reason = record.fields[closingRules.reasonKey] as string
    const label = defsByKey.get(closingRules.reasonKey)?.options?.[reason]?.label ?? reason
    await revokeConsentOnClose(tx, ctx, id, label)
  }

  return record
}
