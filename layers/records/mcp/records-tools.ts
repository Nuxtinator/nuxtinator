// MCP tools for records. Registered by modules/records-mcp.ts only when the
// MCP layer is loaded.
//
// Scopes: reads use `records.read`, writes use `records.write`, schema
// changes `records.schema.manage`. Those only say what a connected app may
// do; which records it can touch is the same per-type answer the HTTP routes
// give (type grants, record visibility, edit shares). Every tool takes an
// optional `org` slug and runs inside `withOrgPermission`, which signs the
// bearer in, picks and checks the org, and builds the tenant context the
// records kernel takes (perms narrowed to the token, `clientId` set, so
// timeline rows read "via <client>").
//
// Writes return the before/after value of every field they changed. There is
// no delete tool; records are closed instead. Address and consent tools live
// with the layer that stores addresses (crm).
import { z } from 'zod'
import { createError } from 'h3'
import type { Transaction } from 'kysely'
import { defineMcpTool, type McpToolContext } from '#mcp-layer'
import { withOrgPermission, type TenantContext } from '#tenant/server'
import type { Database } from '#core/server/database/schema'
import type { Permission } from '#core/app/utils/permissions'
import {
  addComment,
  applyFieldPatch,
  assertRecordVisible,
  availableAdminFieldKinds,
  canUpdateRecord,
  closingRulesOf,
  createField,
  createRecordType,
  getRecord,
  getRecordType,
  getRecordTypeFields,
  getRecordTypes,
  hydrateRecords,
  isClosedStatus,
  listActivity,
  listComments,
  listRecords,
  requireRecordType,
  requireRecordUpdate,
  requireTypePermission,
  resolveTypeCapabilities,
  runRecordsPatchGuards,
  updateField,
  RECORDS_OPTION_KEY_RE,
  RECORDS_SCHEMA_SLUG_RE,
  type RecordsAdminFieldKind,
  type RecordsFieldSetting,
  type RecordsHydratedRecord,
  type RecordTypeSetting
} from '#records/server'

type Tx = Transaction<Database>

// ─── Shared helpers ─────────────────────────────────────────────────────────

const orgInput = z.string().min(1).max(64).optional()
  .describe('Org slug to operate in. Defaults to the X-Active-Org header sent by the client.')

const typeInput = z.string().min(1).max(41)
  .describe('Record type key, e.g. "task" or "contacts" (see records_list_types).')

const idInput = z.string().uuid().describe('Record id, from records_search.')

const fieldsInput = z.record(z.string(), z.unknown())
  .describe('Field values keyed by field key (see records_list_types). Single-value fields take a value (null clears). Multi-value fields (including email/phone) take an array, which replaces every current value, or { "values": [{ "value": "…" }, { "value": "…", "delete": true }] } to add or remove values and keep the rest.')

function run<T>(
  ctx: McpToolContext,
  org: string | undefined,
  perm: Permission,
  fn: (tx: Tx, tenant: TenantContext) => Promise<T>
): Promise<T> {
  return withOrgPermission(ctx.event, { appId: 'records', org }, perm, fn)
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
function diffFields(defs: RecordsFieldSetting[], before: Record<string, unknown> | null, after: Record<string, unknown>): FieldChange[] {
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

function recordOut(record: RecordsHydratedRecord, rules: ReturnType<typeof closingRulesOf>) {
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

async function typeContext(tx: Tx, tenant: TenantContext, typeKey: string) {
  const type = await requireRecordType(tx, typeKey, tenant)
  const defs = (await getRecordTypeFields(tx, typeKey)).filter(d => !d.orphan)
  return { type, defs, rules: closingRulesOf(type, defs) }
}

// The first primary (else first) address of each address field. Driver
// entries all carry the address as `value`.
function primaryAddresses(record: RecordsHydratedRecord, defs: RecordsFieldSetting[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const def of defs) {
    if (def.storage !== 'channels') continue
    const entries = (record.fields[def.key] ?? []) as Array<{ value: string, isPrimary?: boolean }>
    const pick = entries.find(e => e.isPrimary) ?? entries[0]
    if (pick) out[def.key] = pick.value
  }
  return out
}

async function lastActivity(tx: Tx, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const rows = await tx
    .selectFrom('records_activity')
    .select(['record_id', eb => eb.fn.max('created_at').as('last')])
    .where('record_id', 'in', ids)
    .groupBy('record_id')
    .execute()
  return new Map(rows.map(r => [r.record_id, new Date(r.last as unknown as string).toISOString()]))
}

// ─── Read tools ─────────────────────────────────────────────────────────────

export const listRecordTypesTool = defineMcpTool({
  name: 'records_list_types',
  title: 'List Record Types',
  description: 'List the record types you can read (tasks, items, contacts when the CRM is on, and any the org created), with their fields, options, which statuses mean closed and the reasons for closing. Call this before creating or updating records so you know the field keys and allowed values — and before creating a record type, so you reuse or extend one that already fits.',
  appId: 'records',
  scope: 'records.read',
  readOnly: true,
  input: z.object({ org: orgInput }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, 'records.read', async (tx, tenant) => {
      const types: RecordTypeSetting[] = (await getRecordTypes(tx)).filter(t => !t.orphan && !t.hidden)
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
      return text(`${out.length} record type(s)`, {
        types: out,
        canManageSchema: tenant.perms.has('records.schema.manage'),
        kinds: availableAdminFieldKinds()
      })
    })
  }
})

export const searchRecordsTool = defineMcpTool({
  name: 'records_search',
  title: 'Search Records',
  description: 'Search records of one type by text (matches names and any email addresses or phone numbers), status, or an exact email/phone. Closed records are left out unless includeClosed is true. Each result has its primary addresses, status and last activity so you can tell records with the same name apart.',
  appId: 'records',
  scope: 'records.read',
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
    return await run(ctx, input.org, 'records.read', async (tx, tenant) => {
      await requireTypePermission(tx, tenant, input.type, 'read')
      const { defs, rules } = await typeContext(tx, tenant, input.type)
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

      const hydrated = await hydrateRecords(tx, tenant, input.type, rows)
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
  name: 'records_get',
  title: 'Get Record',
  description: 'Get one record with all its fields. For a contact\'s addresses with their consent state, use crm_get_addresses.',
  appId: 'records',
  scope: 'records.read',
  readOnly: true,
  input: z.object({ org: orgInput, type: typeInput, id: idInput }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, 'records.read', async (tx, tenant) => {
      await requireTypePermission(tx, tenant, input.type, 'read')
      const { rules } = await typeContext(tx, tenant, input.type)
      await assertRecordVisible(tx, tenant, input.type, input.id)
      const record = await getRecord(tx, tenant, input.type, input.id)

      return text(`Record ${record.id}`, {
        record: recordOut(record, rules),
        linkedUserId: record.userId,
        canEdit: await canUpdateRecord(tx, tenant, input.type, input.id)
      })
    })
  }
})

export const listTimelineTool = defineMcpTool({
  name: 'records_list_timeline',
  title: 'List Timeline',
  description: 'List a record\'s comments and activity (field changes, addresses added or removed, consent changes), newest first. Pass the returned cursors to get older entries.',
  appId: 'records',
  scope: 'records.read',
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
    return await run(ctx, input.org, 'records.read', async (tx, tenant) => {
      await requireTypePermission(tx, tenant, input.type, 'read')
      await requireRecordType(tx, input.type, tenant)
      await assertRecordVisible(tx, tenant, input.type, input.id)
      const limit = input.limit ?? 20
      const comments = await listComments(tx, input.id, { limit, before: input.commentsCursor })
      const activity = await listActivity(tx, input.id, { limit, before: input.activityCursor }, { ctx: tenant, typeKey: input.type })
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

const shareInput = z.boolean().optional().describe('Set true to assign someone (an assignee or other access-granting people field) who can\'t see the record yet; doing so shares it with them. Without it the call is refused and names those people, so confirm with the user first.')

export const createRecordTool = defineMcpTool({
  name: 'records_create',
  title: 'Create Record',
  description: 'Create a record, e.g. a task from a meeting or a contact from a business card. `fields.name` is required. Email and phone fields take an array of addresses. Adding an address never opts the person in to anything; record consent separately with crm_set_consent.',
  appId: 'records',
  scope: 'records.write',
  input: z.object({ org: orgInput, type: typeInput, fields: fieldsInput, share: shareInput }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, 'records.write', async (tx, tenant) => {
      await requireTypePermission(tx, tenant, input.type, 'create')
      const { defs, rules } = await typeContext(tx, tenant, input.type)
      const record = await applyFieldPatch(tx, tenant, input.type, null, input.fields, {
        sharing: input.share ? 'confirmed' : 'ask'
      })
      const changes = diffFields(defs, null, record.fields)
      return text(`Created ${record.name} (${record.id}). ${changeSummary(changes)}`, {
        record: recordOut(record, rules),
        changes
      })
    })
  }
})

export const updateRecordTool = defineMcpTool({
  name: 'records_update',
  title: 'Update Record',
  description: 'Change fields on a record. Only the fields you pass change. Returns each changed field\'s value before and after, so the change can be shown and undone. To close a record use records_close; to change consent use crm_set_consent.',
  appId: 'records',
  scope: 'records.write',
  input: z.object({ org: orgInput, type: typeInput, id: idInput, fields: fieldsInput, share: shareInput }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, 'records.write', async (tx, tenant) => {
      const { defs, rules } = await typeContext(tx, tenant, input.type)
      await assertRecordVisible(tx, tenant, input.type, input.id)
      await requireRecordUpdate(tx, tenant, input.type, input.id)
      await runRecordsPatchGuards(tx, { typeKey: input.type, recordId: input.id, fields: input.fields })
      const before = await getRecord(tx, tenant, input.type, input.id)
      const record = await applyFieldPatch(tx, tenant, input.type, input.id, input.fields, {
        sharing: input.share ? 'confirmed' : 'ask'
      })
      const changes = diffFields(defs, before.fields, record.fields)
      return text(`Updated ${record.name}. ${changeSummary(changes)}`, {
        record: recordOut(record, rules),
        changes
      })
    })
  }
})

export const closeRecordTool = defineMcpTool({
  name: 'records_close',
  title: 'Close Record',
  description: 'Close (archive) a record by setting a closed status — for a task, mark it done. When the type has a reason field, a reason is required (see closedReasonField in records_list_types). A reason marked revokesConsent (e.g. "asked to be removed") also turns off every consent on the record\'s addresses, including for other records that share them. Reopen a record by setting an open status with records_update.',
  appId: 'records',
  scope: 'records.write',
  input: z.object({
    org: orgInput,
    type: typeInput,
    id: idInput,
    reason: z.string().max(41).optional().describe('Reason option key, from the type\'s closedReasonField options.'),
    status: z.string().max(41).optional().describe('Which closed status to use when the type has several. Defaults to the first.')
  }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, 'records.write', async (tx, tenant) => {
      const { defs, rules } = await typeContext(tx, tenant, input.type)
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
      const reasonDef = rules.reasonKey ? defs.find(d => d.key === rules.reasonKey) : undefined
      const revoked = !!input.reason && !!reasonDef?.options?.[input.reason]?.revokesConsent
      return text(
        `Closed ${record.name}.${revoked ? ' Consent on its addresses was revoked.' : ''} ${changeSummary(changes)}`,
        { record: recordOut(record, rules), changes, consentRevoked: revoked }
      )
    })
  }
})

export const addCommentTool = defineMcpTool({
  name: 'records_add_comment',
  title: 'Add Comment',
  description: 'Add a free-text note to a record\'s timeline, e.g. "Met on Sunday, wants to help with the youth group."',
  appId: 'records',
  scope: 'records.write',
  input: z.object({
    org: orgInput,
    type: typeInput,
    id: idInput,
    body: z.string().min(1).max(10000)
  }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, 'records.write', async (tx, tenant) => {
      await requireTypePermission(tx, tenant, input.type, 'read')
      await requireRecordType(tx, input.type, tenant)
      await assertRecordVisible(tx, tenant, input.type, input.id)
      const comment = await addComment(tx, tenant, input.id, { body: input.body })
      return text('Comment added.', {
        comment: { id: comment.id, body: comment.body, createdAt: comment.createdAt.toISOString() }
      })
    })
  }
})

// ─── Schema tools ───────────────────────────────────────────────────────────

const optionsInput = z.record(
  z.string().regex(RECORDS_OPTION_KEY_RE),
  z.object({ label: z.string().trim().min(1).max(80), color: z.string().max(20).optional() }).strict()
).describe('Choices keyed by option key (lowercase slug), for dropdown, multi-select and tags fields.')

const fieldSpecInput = z.object({
  key: z.string().regex(RECORDS_SCHEMA_SLUG_RE).describe('Field key: lowercase slug, e.g. "venue".'),
  label: z.string().trim().min(1).max(80),
  kind: z.string().describe('One of the kinds in records_list_types → kinds.'),
  required: z.boolean().optional(),
  options: optionsInput.optional(),
  channelType: z.string().max(41).optional().describe('Address fields only: "email" or "phone".'),
  target: z.string().max(41).optional().describe('Connection fields only: the record type it links to, e.g. "milestones".')
}).strict()

async function addFieldTo(tx: Tx, tenant: TenantContext, typeKey: string, spec: z.infer<typeof fieldSpecInput>) {
  const kinds = availableAdminFieldKinds()
  if (!(kinds as readonly string[]).includes(spec.kind)) {
    throw createError({ statusCode: 400, statusMessage: `Unknown field kind ${spec.kind}. Kinds: ${kinds.join(', ')}` })
  }
  return await createField(tx, tenant, typeKey, {
    fieldKey: spec.key,
    kind: spec.kind as RecordsAdminFieldKind,
    label: spec.label,
    required: spec.required,
    options: spec.options,
    channelType: spec.channelType,
    target: spec.target
  })
}

export const createRecordTypeTool = defineMcpTool({
  name: 'records_create_type',
  title: 'Create Record Type',
  description: 'Create a new record type with its fields, for something the org wants to start tracking (events, venues, deliverables). Call records_list_types first: when an existing type fits, add fields to it with records_add_field instead of creating a near-duplicate. Every type gets a name field and a status field (open, done; done closes the record); list the other fields here, and change the status options with records_update_field.',
  appId: 'records',
  scope: 'records.schema.manage',
  input: z.object({
    org: orgInput,
    key: z.string().regex(RECORDS_SCHEMA_SLUG_RE).describe('Type key: lowercase slug, plural, e.g. "events".'),
    label: z.string().trim().min(1).max(80).describe('Plural label, e.g. "Events".'),
    labelSingular: z.string().trim().min(1).max(80).describe('e.g. "Event".'),
    icon: z.string().max(80).optional().describe('A Lucide icon name, e.g. "i-lucide-calendar".'),
    fields: z.array(fieldSpecInput).max(30).optional()
  }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, 'records.schema.manage', async (tx, tenant) => {
      const type = await createRecordType(tx, tenant, {
        typeKey: input.key,
        label: input.label,
        labelSingular: input.labelSingular,
        icon: input.icon
      })
      for (const spec of input.fields ?? []) await addFieldTo(tx, tenant, type.key, spec)
      const fields = (await getRecordTypeFields(tx, type.key)).filter(d => !d.orphan)
      return text(`Created record type ${type.label} with ${fields.length} field(s).`, {
        type: { key: type.key, label: type.label, labelSingular: type.labelSingular },
        fields: fields.map(f => ({ key: f.key, label: f.label, kind: f.kind }))
      })
    })
  }
})

export const addFieldTool = defineMcpTool({
  name: 'records_add_field',
  title: 'Add Field',
  description: 'Add a field to an existing record type, e.g. a "budget" number on deliverables. Prefer this over creating a new type when the use case is an extension of one that exists.',
  appId: 'records',
  scope: 'records.schema.manage',
  input: z.object({ org: orgInput, type: typeInput, field: fieldSpecInput }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, 'records.schema.manage', async (tx, tenant) => {
      await requireRecordType(tx, input.type, tenant)
      const field = await addFieldTo(tx, tenant, input.type, input.field)
      return text(`Added ${field.label} to ${input.type}.`, {
        field: { key: field.key, label: field.label, kind: field.kind }
      })
    })
  }
})

export const updateFieldTool = defineMcpTool({
  name: 'records_update_field',
  title: 'Update Field',
  description: 'Rename a field or add choices to a dropdown, multi-select or tags field — e.g. add a new quarter to a milestones field. Pass only what changes; options you pass are added or relabeled, others stay.',
  appId: 'records',
  scope: 'records.schema.manage',
  input: z.object({
    org: orgInput,
    type: typeInput,
    field: z.string().max(41).describe('The field key.'),
    label: z.string().trim().min(1).max(80).optional(),
    options: optionsInput.optional()
  }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, 'records.schema.manage', async (tx, tenant) => {
      const type = await getRecordType(tx, input.type)
      if (!type || type.orphan) throw createError({ statusCode: 404, statusMessage: `Unknown record type: ${input.type}` })
      const current = (await getRecordTypeFields(tx, input.type)).find(f => f.key === input.field && !f.orphan)
      if (!current) throw createError({ statusCode: 404, statusMessage: `${input.type} has no field ${input.field}` })
      const options = input.options
        ? Object.fromEntries(Object.entries({ ...(current.options ?? {}), ...input.options }))
        : undefined
      const field = await updateField(tx, tenant, input.type, input.field, {
        ...(input.label ? { label: input.label } : {}),
        ...(options ? { options } : {})
      })
      return text(`Updated ${field.label}.`, {
        field: {
          key: field.key,
          label: field.label,
          kind: field.kind,
          options: field.options ? Object.fromEntries(Object.entries(field.options).filter(([, o]) => !o.deleted).map(([k, o]) => [k, o.label])) : undefined
        }
      })
    })
  }
})

export const recordsMcpTools = [
  listRecordTypesTool,
  searchRecordsTool,
  getRecordTool,
  listTimelineTool,
  createRecordTool,
  updateRecordTool,
  closeRecordTool,
  addCommentTool,
  createRecordTypeTool,
  addFieldTool,
  updateFieldTool
]
