// MCP tools for the crm's contact addresses and consent. Registered by
// modules/crm-mcp.ts only when the MCP layer is loaded. Record reads and
// writes are the records layer's tools (records_get, records_update, …);
// these cover what only the crm stores: email addresses and phone numbers
// as shared identities, their consent per purpose, and suppression.
//
// Scopes follow the records tools: reads use `records.read`, writes
// `records.write`. Which records a call can touch is the same per-type
// answer the HTTP routes give. Nothing here grants consent as a side effect:
// only `crm_set_consent` does, with evidence.
import { z } from 'zod'
import { createError } from 'h3'
import type { Transaction } from 'kysely'
import { defineMcpTool, type McpToolContext } from '#mcp-layer'
import { withOrgPermission, type TenantContext } from '#tenant/server'
import type { Database } from '#core/server/database/schema'
import type { Permission } from '#core/app/utils/permissions'
import type { CrmChannelEntry } from '#crm'
import { assertRecordVisible, canUpdateRecord, getRecord, getRecordTypeFields, normalizeChannelValue, recordRecordsActivity, requireRecordType, requireRecordUpdate, requireTypePermission, type RecordsFieldSetting, type RecordsHydratedRecord } from '#records/server'
import {
  claimChannel,
  getChannelType,
  getConsentState,
  getRegisteredConsentPurposes,
  grantConsent,
  isSuppressed,
  linkChannel,
  revokeConsent,
  unlinkChannel
} from '#crm/server'
import { accountOwnedChannelTypes, assertNotAccountOwned } from '../server/utils/account-link'

type Tx = Transaction<Database>

// ─── Shared helpers ─────────────────────────────────────────────────────────

const orgInput = z.string().min(1).max(64).optional()
  .describe('Org slug to operate in. Defaults to the X-Active-Org header sent by the client.')

const typeInput = z.string().min(1).max(41)
  .describe('Record type key, e.g. "contacts" (see records_list_types).')

const idInput = z.string().uuid().describe('Record id, from records_search.')

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

function diffFields(defs: RecordsFieldSetting[], before: Record<string, unknown>, after: Record<string, unknown>): FieldChange[] {
  const labels = new Map(defs.map(d => [d.key, d.label]))
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  const changes: FieldChange[] = []
  for (const key of keys) {
    const b = before[key] ?? null
    const a = after[key] ?? null
    if (JSON.stringify(b) !== JSON.stringify(a)) {
      changes.push({ field: key, label: labels.get(key) ?? key, before: b, after: a })
    }
  }
  return changes
}

async function typeContext(tx: Tx, tenant: TenantContext, typeKey: string) {
  await requireRecordType(tx, typeKey, tenant)
  const defs = (await getRecordTypeFields(tx, typeKey)).filter(d => !d.orphan)
  return { defs }
}

// The channel field an address goes into: the named field, else the first
// field holding the named (or guessed) channel type.
function channelFieldFor(defs: RecordsFieldSetting[], field: string | undefined, channelType: string | undefined, value: string): RecordsFieldSetting {
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
async function findLink(tx: Tx, record: RecordsHydratedRecord, defs: RecordsFieldSetting[], address: string): Promise<CrmChannelEntry & { fieldKey: string }> {
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

// ─── Tools ──────────────────────────────────────────────────────────────────

export const getAddressesTool = defineMcpTool({
  name: 'crm_get_addresses',
  title: 'Get Addresses',
  description: 'Get a record\'s email addresses and phone numbers, whether each is suppressed, and the consent state of each for every consent purpose (also listed).',
  appId: 'crm',
  scope: 'records.read',
  readOnly: true,
  input: z.object({ org: orgInput, type: typeInput, id: idInput }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, 'records.read', async (tx, tenant) => {
      await requireTypePermission(tx, tenant, input.type, 'read')
      const { defs } = await typeContext(tx, tenant, input.type)
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
      const consentPurposes = getRegisteredConsentPurposes().map(p => ({ key: p.key, title: p.title, description: p.description ?? null }))
      return text(`${channels.length} address(es)`, {
        channels,
        consentPurposes,
        accountOwnedChannelTypes: accountOwnedChannelTypes(record.userId),
        canEdit: await canUpdateRecord(tx, tenant, input.type, input.id)
      })
    })
  }
})

export const linkChannelTool = defineMcpTool({
  name: 'crm_link_channel',
  title: 'Add Email or Phone',
  description: 'Add an email address or phone number to a record. Adding an address never opts the person in to anything; record consent separately with crm_set_consent.',
  appId: 'crm',
  scope: 'records.write',
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
    return await run(ctx, input.org, 'records.write', async (tx, tenant) => {
      const { defs } = await typeContext(tx, tenant, input.type)
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
  scope: 'records.write',
  input: z.object({
    org: orgInput,
    type: typeInput,
    id: idInput,
    address: z.string().min(1).max(320).describe('The email address or phone number, or its linkId/channelId from crm_get_addresses.')
  }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, 'records.write', async (tx, tenant) => {
      const { defs } = await typeContext(tx, tenant, input.type)
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
  description: 'Record that the person opted in to or out of a consent purpose (see consentPurposes in crm_get_addresses) for one of their addresses. Requires how they told you (source) and what they said or did (evidence), which are kept as proof. Consent belongs to the address, so it applies to every record that shares it.',
  appId: 'crm',
  scope: 'records.write',
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
    return await run(ctx, input.org, 'records.write', async (tx, tenant) => {
      const { defs } = await typeContext(tx, tenant, input.type)
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
        await recordRecordsActivity(tx, tenant, input.id, 'consent_changed', {
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
  getAddressesTool,
  linkChannelTool,
  unlinkChannelTool,
  setConsentTool
]
