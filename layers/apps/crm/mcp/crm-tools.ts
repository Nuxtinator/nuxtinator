// MCP tools for the CRM. Registered by modules/crm-mcp.ts only when the MCP
// layer is loaded.
//
// Scopes: reads use `crm.read`, writes use `crm.write`. Those only say what
// a connected app may do; which records it can touch is the same per-type
// answer the HTTP routes give (type grants, record visibility, edit shares).
// Every tool takes an optional `org` slug and runs inside `withOrgPermission`,
// which signs the bearer in, picks and checks the org, and builds the tenant
// context the CRM kernel takes (perms narrowed to the token, `clientId` set,
// so timeline rows read "via <client>").
//
// Writes return the before/after value of every field they changed. Nothing here grants
// consent as a side effect: only `crm_set_consent` does, with evidence.
// There is no delete tool; records are closed instead.
import { z } from 'zod'
import { createError } from 'h3'
import type { Transaction } from 'kysely'
import { defineMcpTool, type McpToolContext } from '#mcp-layer'
import { withOrgPermission, type TenantContext } from '#tenant/server'
import type { Database } from '#core/server/database/schema'
import type { Permission } from '#core/app/utils/permissions'
import type { CrmChannelEntry } from '#crm'
import {
  addComment,
  applyFieldPatch,
  assertRecordVisible,
  canUpdateRecord,
  claimChannel,
  closingRulesOf,
  getChannelType,
  getConsentState,
  getRecord,
  getRecordTypeFields,
  getRecordTypes,
  getRegisteredConsentPurposes,
  grantConsent,
  hydrateRecords,
  isClosedStatus,
  isSuppressed,
  linkChannel,
  listActivity,
  listComments,
  listRecords,
  normalizeChannelValue,
  recordCrmActivity,
  requireRecordType,
  requireRecordUpdate,
  requireTypePermission,
  resolveTypeCapabilities,
  revokeConsent,
  unlinkChannel,
  type CrmFieldSetting,
  type CrmHydratedRecord,
  type CrmRecordTypeSetting
} from '#crm/server'
import { accountOwnedChannelTypes, assertNotAccountOwned, assertPatchKeepsAccountFields } from '../server/utils/account-link'

type Tx = Transaction<Database>

// ─── Shared helpers ─────────────────────────────────────────────────────────

const orgInput = z.string().min(1).max(64).optional()
  .describe('Org slug to operate in. Defaults to the X-Active-Org header sent by the client.')

const typeInput = z.string().min(1).max(41)
  .describe('Record type key, e.g. "contacts" (see crm_list_record_types).')

const idInput = z.string().uuid().describe('Record id, from crm_search_records.')

const fieldsInput = z.record(z.string(), z.unknown())
  .describe('Field values keyed by field key (see crm_list_record_types). Single-value fields take a value (null clears). Multi-value fields (including email/phone) take an array, which replaces every current value, or { "values": [{ "value": "…" }, { "value": "…", "delete": true }] } to add or remove values and keep the rest.')

function run<T>(
  ctx: McpToolContext,
  org: string | undefined,
  perm: Permission,
  fn: (tx: Tx, tenant: TenantContext) => Promise<T>
): Promise<T> {
  return withOrgPermission(ctx.event, { appId: 'crm', org }, perm, fn)
}

function text(message: string, structured: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: message }], structuredContent: structured }
}

interface FieldChange {
  field: string
  label: string
  before: unknown
  after: unknown
}

// Every field whose value differs between two snapshots, including side
// effects of the patch (e.g. the reason cleared when a record reopens).
function diffFields(defs: CrmFieldSetting[], before: Record<string, unknown> | null, after: Record<string, unknown>): FieldChange[] {
  const labels = new Map(defs.map(d => [d.key, d.label]))
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after)])
  const changes: FieldChange[] = []
  for (const key of keys) {
    const b = before?.[key] ?? null
    const a = after[key] ?? null
    const empty = (v: unknown) => v === null || (Array.isArray(v) && v.length === 0)
    if (before === null && empty(a)) continue
    if (JSON.stringify(b) !== JSON.stringify(a)) {
      changes.push({ field: key, label: labels.get(key) ?? key, before: b, after: a })
    }
  }
  return changes
}

function changeSummary(changes: FieldChange[]): string {
  return changes.length === 0 ? 'No fields changed.' : `Changed: ${changes.map(c => c.label).join(', ')}.`
}

function recordOut(record: CrmHydratedRecord, rules: ReturnType<typeof closingRulesOf>) {
  return {
    id: record.id,
    type: record.recordType,
    name: record.name,
    status: record.status,
    closed: isClosedStatus(rules, record.status),
    fields: record.fields,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString()
  }
}

async function typeContext(tx: Tx, typeKey: string) {
  const type = await requireRecordType(tx, typeKey)
  const defs = (await getRecordTypeFields(tx, typeKey)).filter(d => !d.orphan)
  return { type, defs, rules: closingRulesOf(type, defs) }
}

// The first primary (else first) address of each channel field.
function primaryAddresses(record: CrmHydratedRecord, defs: CrmFieldSetting[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const def of defs) {
    if (def.storage !== 'channels') continue
    const entries = (record.fields[def.key] ?? []) as CrmChannelEntry[]
    const pick = entries.find(e => e.isPrimary) ?? entries[0]
    if (pick) out[def.key] = pick.value
  }
  return out
}

async function lastActivity(tx: Tx, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const rows = await tx
    .selectFrom('crm_record_activity')
    .select(['record_id', eb => eb.fn.max('created_at').as('last')])
    .where('record_id', 'in', ids)
    .groupBy('record_id')
    .execute()
  return new Map(rows.map(r => [r.record_id, new Date(r.last as unknown as string).toISOString()]))
}

// The channel field an address goes into: the named field, else the first
// field holding the named (or guessed) channel type.
function channelFieldFor(defs: CrmFieldSetting[], field: string | undefined, channelType: string | undefined, value: string): CrmFieldSetting {
  const channelFields = defs.filter(d => d.storage === 'channels')
  if (field) {
    const def = channelFields.find(d => d.key === field)
    if (!def) throw createError({ statusCode: 400, statusMessage: `${field} is not an email/phone field. Channel fields: ${channelFields.map(d => d.key).join(', ') || 'none'}` })
    if (channelType && def.channelType !== channelType) {
      throw createError({ statusCode: 400, statusMessage: `${field} holds ${def.channelType} addresses, not ${channelType}.` })
    }
    return def
  }
  const wanted = channelType ?? (value.includes('@') ? 'email' : 'phone')
  const def = channelFields.find(d => d.channelType === wanted)
  if (!def) throw createError({ statusCode: 400, statusMessage: `This record type has no ${wanted} field. Channel fields: ${channelFields.map(d => `${d.key} (${d.channelType})`).join(', ') || 'none'}` })
  return def
}

// The record's link for an address, matched by link id, channel id or the
// address itself (compared in normalized form).
async function findLink(tx: Tx, record: CrmHydratedRecord, defs: CrmFieldSetting[], address: string): Promise<CrmChannelEntry & { fieldKey: string }> {
  const entries = defs
    .filter(d => d.storage === 'channels')
    .flatMap(d => ((record.fields[d.key] ?? []) as CrmChannelEntry[]).map(e => ({ ...e, fieldKey: d.key })))
  const byId = entries.find(e => e.linkId === address || e.channelId === address)
  if (byId) return byId
  for (const entry of entries) {
    const channelType = await getChannelType(tx, entry.channelType)
    if (!channelType) continue
    const want = normalizeChannelValue(channelType.valueFormat, address).normalized
    const have = normalizeChannelValue(channelType.valueFormat, entry.value).normalized
    if (want === have) return entry
  }
  throw createError({ statusCode: 404, statusMessage: `${address} is not on this record. Addresses: ${entries.map(e => e.value).join(', ') || 'none'}` })
}

// ─── Read tools ─────────────────────────────────────────────────────────────

export const listRecordTypesTool = defineMcpTool({
  name: 'crm_list_record_types',
  title: 'List Record Types',
  description: 'List the CRM record types you can read (contacts plus any the org created), with their fields, options, which statuses mean closed, the reasons for closing, and the consent purposes. Call this before creating or updating records so you know the field keys and allowed values.',
  appId: 'crm',
  scope: 'crm.read',
  readOnly: true,
  input: z.object({ org: orgInput }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, 'crm.read', async (tx, tenant) => {
      const types: CrmRecordTypeSetting[] = (await getRecordTypes(tx)).filter(t => !t.orphan && !t.hidden)
      const out = []
      for (const type of types) {
        const caps = await resolveTypeCapabilities(tx, tenant, type.key)
        if (!caps.read) continue
        const defs = (await getRecordTypeFields(tx, type.key)).filter(d => !d.orphan && !d.hidden)
        const rules = closingRulesOf(type, defs)
        out.push({
          key: type.key,
          label: type.label,
          labelSingular: type.labelSingular,
          canCreate: caps.create,
          canUpdate: caps.update,
          statusField: rules.statusKey,
          closedStatuses: rules.closedStatuses,
          closedReasonField: rules.reasonKey,
          fields: defs.map(d => ({
            key: d.key,
            label: d.label,
            kind: d.kind,
            required: d.required,
            ...(d.multiple ? { multiple: true } : {}),
            ...(d.channelType ? { channelType: d.channelType } : {}),
            ...(d.target ? { target: d.target } : {}),
            ...(d.options
              ? {
                  options: Object.fromEntries(Object.entries(d.options)
                    .filter(([, o]) => !o.deleted)
                    .map(([k, o]) => [k, {
                      label: o.label,
                      ...(o.closed ? { closed: true } : {}),
                      ...(o.revokesConsent ? { revokesConsent: true } : {})
                    }]))
                }
              : {})
          }))
        })
      }
      const consentPurposes = getRegisteredConsentPurposes().map(p => ({ key: p.key, title: p.title, description: p.description ?? null }))
      return text(`${out.length} record type(s)`, { types: out, consentPurposes })
    })
  }
})

export const searchRecordsTool = defineMcpTool({
  name: 'crm_search_records',
  title: 'Search Records',
  description: 'Search records of one type by text (matches names, email addresses and phone numbers), status, or an exact email/phone. Closed records are left out unless includeClosed is true. Each result has the primary email/phone, status and last activity so you can tell people with the same name apart.',
  appId: 'crm',
  scope: 'crm.read',
  readOnly: true,
  input: z.object({
    org: orgInput,
    type: typeInput,
    query: z.string().max(200).optional().describe('Text to look for in names, emails and phone numbers.'),
    status: z.string().max(41).optional().describe('Only records with this status key.'),
    channel: z.string().max(320).optional().describe('An exact email address or phone number.'),
    includeClosed: z.boolean().optional(),
    limit: z.number().int().min(1).max(50).optional(),
    offset: z.number().int().min(0).optional()
  }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, 'crm.read', async (tx, tenant) => {
      await requireTypePermission(tx, tenant, input.type, 'read')
      const { defs, rules } = await typeContext(tx, input.type)
      const limit = input.limit ?? 10
      const base = {
        q: input.query,
        filters: input.status && rules.statusKey ? { [rules.statusKey]: input.status } : undefined,
        excludeStatuses: input.includeClosed || input.status ? undefined : rules.closedStatuses,
        sort: 'updated_at',
        dir: 'desc' as const
      }

      let rows: Awaited<ReturnType<typeof listRecords>>['items']
      let total: number
      if (input.channel) {
        // An exact address may sit in any of the type's channel fields.
        const seen = new Map<string, (typeof rows)[number]>()
        for (const def of defs.filter(d => d.storage === 'channels')) {
          const res = await listRecords(tx, tenant, input.type, {
            ...base,
            filters: { ...base.filters, [def.key]: input.channel },
            limit: 100
          })
          for (const item of res.items) seen.set(item.id, item)
        }
        const all = [...seen.values()]
        total = all.length
        const start = input.offset ?? 0
        rows = all.slice(start, start + limit)
      } else {
        const res = await listRecords(tx, tenant, input.type, { ...base, limit, offset: input.offset })
        rows = res.items
        total = res.total
      }

      const hydrated = await hydrateRecords(tx, input.type, rows)
      const last = await lastActivity(tx, hydrated.map(r => r.id))
      const records = hydrated.map(r => ({
        id: r.id,
        name: r.name,
        status: r.status,
        closed: isClosedStatus(rules, r.status),
        addresses: primaryAddresses(r, defs),
        updatedAt: r.updatedAt.toISOString(),
        lastActivityAt: last.get(r.id) ?? null
      }))
      return text(`${records.length} of ${total} record(s)`, {
        records,
        total,
        hasMore: (input.offset ?? 0) + records.length < total
      })
    })
  }
})

export const getRecordTool = defineMcpTool({
  name: 'crm_get_record',
  title: 'Get Record',
  description: 'Get one record with all its fields, its email addresses and phone numbers, and the consent state of each address.',
  appId: 'crm',
  scope: 'crm.read',
  readOnly: true,
  input: z.object({ org: orgInput, type: typeInput, id: idInput }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, 'crm.read', async (tx, tenant) => {
      await requireTypePermission(tx, tenant, input.type, 'read')
      const { defs, rules } = await typeContext(tx, input.type)
      await assertRecordVisible(tx, tenant, input.type, input.id)
      const record = await getRecord(tx, tenant, input.type, input.id)

      const entries = defs
        .filter(d => d.storage === 'channels')
        .flatMap(d => ((record.fields[d.key] ?? []) as CrmChannelEntry[]).map(e => ({ ...e, field: d.key })))
      const consents = await getConsentState(tx, entries.map(e => e.channelId))
      const channels = []
      for (const e of entries) {
        channels.push({
          field: e.field,
          linkId: e.linkId,
          channelId: e.channelId,
          channelType: e.channelType,
          value: e.value,
          label: e.label,
          primary: e.isPrimary,
          verified: e.verified,
          suppressed: await isSuppressed(tx, e.channelId),
          consents: (consents.get(e.channelId) ?? []).map(c => ({
            purpose: c.purpose,
            status: c.status,
            source: c.source,
            grantedAt: c.grantedAt?.toISOString() ?? null,
            revokedAt: c.revokedAt?.toISOString() ?? null
          }))
        })
      }
      return text(`Record ${record.id}`, {
        record: recordOut(record, rules),
        channels,
        accountOwnedChannelTypes: accountOwnedChannelTypes(record.userId),
        canEdit: await canUpdateRecord(tx, tenant, input.type, input.id)
      })
    })
  }
})

export const listTimelineTool = defineMcpTool({
  name: 'crm_list_timeline',
  title: 'List Timeline',
  description: 'List a record\'s comments and activity (field changes, addresses added or removed, consent changes), newest first. Pass the returned cursors to get older entries.',
  appId: 'crm',
  scope: 'crm.read',
  readOnly: true,
  input: z.object({
    org: orgInput,
    type: typeInput,
    id: idInput,
    limit: z.number().int().min(1).max(50).optional(),
    commentsCursor: z.string().max(100).optional(),
    activityCursor: z.string().max(100).optional()
  }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, 'crm.read', async (tx, tenant) => {
      await requireTypePermission(tx, tenant, input.type, 'read')
      await requireRecordType(tx, input.type)
      await assertRecordVisible(tx, tenant, input.type, input.id)
      const limit = input.limit ?? 20
      const comments = await listComments(tx, input.id, { limit, before: input.commentsCursor })
      const activity = await listActivity(tx, input.id, { limit, before: input.activityCursor })
      const entries = [
        ...comments.items.map(c => ({
          kind: 'comment' as const,
          id: c.id,
          at: c.createdAt.toISOString(),
          author: c.authorName,
          viaClient: c.viaClient,
          body: c.body
        })),
        ...activity.items.map(a => ({
          kind: 'activity' as const,
          id: a.id,
          at: a.createdAt.toISOString(),
          author: a.actorName,
          viaClient: a.viaClient,
          action: a.action,
          field: a.fieldKey,
          before: a.oldValue,
          after: a.newValue,
          note: a.note
        }))
      ].sort((x, y) => y.at.localeCompare(x.at))
      return text(`${entries.length} timeline entr${entries.length === 1 ? 'y' : 'ies'}`, {
        entries,
        commentsCursor: comments.nextCursor,
        activityCursor: activity.nextCursor
      })
    })
  }
})

// ─── Write tools ────────────────────────────────────────────────────────────

export const createRecordTool = defineMcpTool({
  name: 'crm_create_record',
  title: 'Create Record',
  description: 'Create a record, e.g. a contact from a business card. `fields.name` is required. Email and phone fields take an array of addresses. Adding an address never opts the person in to anything; record consent separately with crm_set_consent.',
  appId: 'crm',
  scope: 'crm.write',
  input: z.object({ org: orgInput, type: typeInput, fields: fieldsInput }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, 'crm.write', async (tx, tenant) => {
      await requireTypePermission(tx, tenant, input.type, 'create')
      const { defs, rules } = await typeContext(tx, input.type)
      const record = await applyFieldPatch(tx, tenant, input.type, null, input.fields)
      const changes = diffFields(defs, null, record.fields)
      return text(`Created ${record.name} (${record.id}). ${changeSummary(changes)}`, {
        record: recordOut(record, rules),
        changes
      })
    })
  }
})

export const updateRecordTool = defineMcpTool({
  name: 'crm_update_record',
  title: 'Update Record',
  description: 'Change fields on a record. Only the fields you pass change. Returns each changed field\'s value before and after, so the change can be shown and undone. To close a record use crm_close_record; to change consent use crm_set_consent.',
  appId: 'crm',
  scope: 'crm.write',
  input: z.object({ org: orgInput, type: typeInput, id: idInput, fields: fieldsInput }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, 'crm.write', async (tx, tenant) => {
      const { defs, rules } = await typeContext(tx, input.type)
      await assertRecordVisible(tx, tenant, input.type, input.id)
      await requireRecordUpdate(tx, tenant, input.type, input.id)
      await assertPatchKeepsAccountFields(tx, input.type, input.id, input.fields)
      const before = await getRecord(tx, tenant, input.type, input.id)
      const record = await applyFieldPatch(tx, tenant, input.type, input.id, input.fields)
      const changes = diffFields(defs, before.fields, record.fields)
      return text(`Updated ${record.name}. ${changeSummary(changes)}`, {
        record: recordOut(record, rules),
        changes
      })
    })
  }
})

export const closeRecordTool = defineMcpTool({
  name: 'crm_close_record',
  title: 'Close Record',
  description: 'Close (archive) a record by setting a closed status. When the type has a reason field, a reason is required (see closedReasonField in crm_list_record_types). A reason marked revokesConsent (e.g. "asked to be removed") also turns off every consent on the record\'s addresses, including for other records that share them. Reopen a record by setting an open status with crm_update_record.',
  appId: 'crm',
  scope: 'crm.write',
  input: z.object({
    org: orgInput,
    type: typeInput,
    id: idInput,
    reason: z.string().max(41).optional().describe('Reason option key, from the type\'s closedReasonField options.'),
    status: z.string().max(41).optional().describe('Which closed status to use when the type has several. Defaults to the first.')
  }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, 'crm.write', async (tx, tenant) => {
      const { defs, rules } = await typeContext(tx, input.type)
      if (!rules.statusKey || rules.closedStatuses.length === 0) {
        throw createError({ statusCode: 400, statusMessage: `${input.type} records can't be closed: no status counts as closed.` })
      }
      const status = input.status ?? rules.closedStatuses[0]!
      if (!rules.closedStatuses.includes(status)) {
        throw createError({ statusCode: 400, statusMessage: `${status} is not a closed status. Closed statuses: ${rules.closedStatuses.join(', ')}` })
      }
      if (input.reason && !rules.reasonKey) {
        throw createError({ statusCode: 400, statusMessage: `${input.type} records have no reason field; close without a reason.` })
      }
      await assertRecordVisible(tx, tenant, input.type, input.id)
      await requireRecordUpdate(tx, tenant, input.type, input.id)
      const before = await getRecord(tx, tenant, input.type, input.id)
      const patch: Record<string, unknown> = { [rules.statusKey]: status }
      if (rules.reasonKey && input.reason !== undefined) patch[rules.reasonKey] = input.reason
      const record = await applyFieldPatch(tx, tenant, input.type, input.id, patch)
      const changes = diffFields(defs, before.fields, record.fields)
      const revoked = !!input.reason && rules.revokingReasons.includes(input.reason)
      return text(
        `Closed ${record.name}.${revoked ? ' Consent on its addresses was revoked.' : ''} ${changeSummary(changes)}`,
        { record: recordOut(record, rules), changes, consentRevoked: revoked }
      )
    })
  }
})

export const addCommentTool = defineMcpTool({
  name: 'crm_add_comment',
  title: 'Add Comment',
  description: 'Add a free-text note to a record\'s timeline, e.g. "Met on Sunday, wants to help with the youth group."',
  appId: 'crm',
  scope: 'crm.write',
  input: z.object({
    org: orgInput,
    type: typeInput,
    id: idInput,
    body: z.string().min(1).max(10000)
  }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, 'crm.write', async (tx, tenant) => {
      await requireRecordType(tx, input.type)
      await assertRecordVisible(tx, tenant, input.type, input.id)
      await requireRecordUpdate(tx, tenant, input.type, input.id)
      const comment = await addComment(tx, tenant, input.id, { body: input.body })
      return text('Comment added.', {
        comment: { id: comment.id, body: comment.body, createdAt: comment.createdAt.toISOString() }
      })
    })
  }
})

export const linkChannelTool = defineMcpTool({
  name: 'crm_link_channel',
  title: 'Add Email or Phone',
  description: 'Add an email address or phone number to a record. Adding an address never opts the person in to anything; record consent separately with crm_set_consent.',
  appId: 'crm',
  scope: 'crm.write',
  input: z.object({
    org: orgInput,
    type: typeInput,
    id: idInput,
    value: z.string().min(1).max(320).describe('The email address or phone number.'),
    channelType: z.string().max(41).optional().describe('e.g. "email" or "phone". Guessed from the value when omitted.'),
    field: z.string().max(41).optional().describe('The channel field to add it to, when the type has several of the same kind.'),
    label: z.string().max(80).optional().describe('e.g. "work" or "home".'),
    primary: z.boolean().optional()
  }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, 'crm.write', async (tx, tenant) => {
      const { defs } = await typeContext(tx, input.type)
      await assertRecordVisible(tx, tenant, input.type, input.id)
      await requireRecordUpdate(tx, tenant, input.type, input.id)
      const def = channelFieldFor(defs, input.field, input.channelType, input.value)
      await assertNotAccountOwned(tx, input.id, { channelType: def.channelType })
      const before = await getRecord(tx, tenant, input.type, input.id)
      const channel = await claimChannel(tx, { channelType: def.channelType!, value: input.value })
      await linkChannel(tx, tenant, input.id, def.key, channel.id, { label: input.label, primary: input.primary })
      const record = await getRecord(tx, tenant, input.type, input.id)
      const changes = diffFields(defs, before.fields, record.fields)
      return text(`${changes.length > 0 ? 'Added' : 'Already on the record:'} ${channel.value} (${def.label}).`, {
        field: def.key,
        entries: record.fields[def.key] ?? [],
        changes
      })
    })
  }
})

export const unlinkChannelTool = defineMcpTool({
  name: 'crm_unlink_channel',
  title: 'Remove Email or Phone',
  description: 'Remove an email address or phone number from a record. The address\'s consent history is kept.',
  appId: 'crm',
  scope: 'crm.write',
  input: z.object({
    org: orgInput,
    type: typeInput,
    id: idInput,
    address: z.string().min(1).max(320).describe('The email address or phone number, or its linkId/channelId from crm_get_record.')
  }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, 'crm.write', async (tx, tenant) => {
      const { defs } = await typeContext(tx, input.type)
      await assertRecordVisible(tx, tenant, input.type, input.id)
      await requireRecordUpdate(tx, tenant, input.type, input.id)
      const before = await getRecord(tx, tenant, input.type, input.id)
      const link = await findLink(tx, before, defs, input.address)
      await assertNotAccountOwned(tx, input.id, { channelType: link.channelType })
      await unlinkChannel(tx, tenant, input.id, link.linkId)
      const record = await getRecord(tx, tenant, input.type, input.id)
      return text(`Removed ${link.value}.`, {
        field: link.fieldKey,
        entries: record.fields[link.fieldKey] ?? [],
        changes: diffFields(defs, before.fields, record.fields)
      })
    })
  }
})

export const setConsentTool = defineMcpTool({
  name: 'crm_set_consent',
  title: 'Set Consent',
  description: 'Record that the person opted in to or out of a consent purpose (see consentPurposes in crm_list_record_types) for one of their addresses. Requires how they told you (source) and what they said or did (evidence), which are kept as proof. Consent belongs to the address, so it applies to every record that shares it.',
  appId: 'crm',
  scope: 'crm.write',
  input: z.object({
    org: orgInput,
    type: typeInput,
    id: idInput,
    address: z.string().min(1).max(320).describe('The email address or phone number on this record, or its channelId.'),
    purpose: z.string().min(1).max(41),
    status: z.enum(['opt_in', 'opt_out']),
    source: z.enum(['verbal', 'form', 'other']).describe('How the person told you: verbal (in person or on the phone), form, or other.'),
    evidence: z.string().trim().min(3).max(2000).describe('What the person said or did, e.g. "Said yes to the newsletter at Sunday\'s meeting."')
  }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, 'crm.write', async (tx, tenant) => {
      const { defs } = await typeContext(tx, input.type)
      await assertRecordVisible(tx, tenant, input.type, input.id)
      await requireRecordUpdate(tx, tenant, input.type, input.id)
      const record = await getRecord(tx, tenant, input.type, input.id)
      const link = await findLink(tx, record, defs, input.address)

      const prior = (await getConsentState(tx, [link.channelId])).get(link.channelId)
        ?.find(c => c.purpose === input.purpose) ?? null
      // No ip/user agent: over MCP they'd describe the AI client, not anyone
      // involved in the consent. The client id lands in the event's meta.
      const change = {
        channelId: link.channelId,
        purpose: input.purpose,
        source: input.source,
        captureMeta: { note: input.evidence }
      }
      const result = input.status === 'opt_in'
        ? await grantConsent(tx, tenant, change)
        : await revokeConsent(tx, tenant, change)
      if (result.changed) {
        await recordCrmActivity(tx, tenant, input.id, 'consent_changed', {
          note: input.evidence,
          old: prior ? { purpose: prior.purpose, status: prior.status } : null,
          new: {
            channel_id: link.channelId,
            channel_type: link.channelType,
            value: link.value,
            purpose: input.purpose,
            status: input.status,
            source: input.source
          }
        })
      }
      const consents = (await getConsentState(tx, [link.channelId])).get(link.channelId) ?? []
      return text(
        result.changed
          ? `${link.value}: ${input.purpose} is now ${input.status === 'opt_in' ? 'opted in' : 'opted out'}.`
          : `${link.value}: ${input.purpose} was already ${input.status === 'opt_in' ? 'opted in' : 'opted out'}; nothing changed.`,
        {
          address: link.value,
          channelId: link.channelId,
          changed: result.changed,
          before: prior ? prior.status : null,
          after: input.status,
          consents: consents.map(c => ({ purpose: c.purpose, status: c.status, source: c.source })),
          suppressed: await isSuppressed(tx, link.channelId)
        }
      )
    })
  }
})

export const crmMcpTools = [
  listRecordTypesTool,
  searchRecordsTool,
  getRecordTool,
  listTimelineTool,
  createRecordTool,
  updateRecordTool,
  closeRecordTool,
  addCommentTool,
  linkChannelTool,
  unlinkChannelTool,
  setConsentTool
]
