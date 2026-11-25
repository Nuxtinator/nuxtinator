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
import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import { defineMcpTool, mcpError, type McpToolContext } from '#mcp-layer'
import { withOrgPermission, type TenantContext } from '#tenant/server'
import type { Database } from '#core/server/database/schema'
import type { Permission } from '#core/app/utils/permissions'
import {
  activityValue,
  addComment,
  applyFieldPatch,
  assertRecordVisible,
  availableAdminFieldKinds,
  beginRecordAttachmentUpload,
  canUpdateRecord,
  closingRulesOf,
  completeRecordAttachmentUpload,
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
  recordRecordsActivity,
  requireRecordType,
  requireRecordUpdate,
  requireTypePermission,
  resolveTypeCapabilities,
  runRecordsPatchGuards,
  updateField,
  updateRecordType,
  RECORDS_ATTACHMENT_MAX_MB,
  RECORDS_OPTION_KEY_RE,
  RECORDS_SHARE_CONFIRMATION,
  RECORDS_SCHEMA_SLUG_RE,
  type RecordsAdminFieldKind,
  type RecordsFieldSetting,
  type RecordsHydratedRecord,
  type RecordTypeSetting
} from '#records/server'
import type { RecordsFieldOption } from '#records'

type Tx = Transaction<Database>

// ─── Shared helpers ─────────────────────────────────────────────────────────

const orgInput = z.string().min(1).max(64).optional()
  .describe('Org slug to operate in. Defaults to the X-Active-Org header sent by the client.')

const typeInput = z.string().min(1).max(41)
  .describe('Record type key, e.g. "task" or "contacts" (see records_list_types).')

const idInput = z.string().uuid().describe('Record id, from records_search.')

const fieldsInput = z.record(z.string(), z.unknown())
  .describe('Field values keyed by field key (see records_list_types). Single-value fields take a value (null clears). Multi-value fields (including email/phone) take an array, which replaces every current value, or { "values": [{ "value": "…" }, { "value": "…", "delete": true }] } to add or remove values and keep the rest. An attachments field takes ids of files already on it, to reorder or remove them; add files with records_begin_attachment_upload.')

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
  description: 'List the record types you can read (tasks, items, contacts when the CRM is on, and any the org created), with their fields, options, which statuses mean closed and the reasons for closing. A field of kind rich_text (the description of a task) holds Markdown. A type with a due date (dueField) also has reminder (how long before the due date the record\'s assignees, or whoever set it, get a reminder) and repeat (closing a record that repeats makes the next one, due one interval later); both need the record to have a due date. Call this before creating or updating records so you know the field keys and allowed values — and before creating a record type, so you reuse or extend one that already fits.',
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
          dueField: defs.find(d => d.due)?.key ?? null,
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

const shareInput = z.boolean().optional().describe('Set true to assign someone (an assignee or other access-granting people field) who can\'t see the record yet, or to move an existing task under a parent other people can see; either shares it (a task under a parent is seen by everyone who sees the parent). Without it the call is refused and says who it would be shared with, so confirm with the user first.')

export const createRecordTool = defineMcpTool({
  name: 'records_create',
  title: 'Create Record',
  description: 'Create a record, e.g. a task from a meeting or a contact from a business card. `fields.name` is required. Email and phone fields take an array of addresses. Adding an address never opts the person in to anything; record consent separately with crm_set_consent. To create several records, use records_create_many.',
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

async function updateOne(
  tx: Tx,
  tenant: TenantContext,
  typeKey: string,
  defs: RecordsFieldSetting[],
  id: string,
  fields: Record<string, unknown>,
  share: boolean | undefined
) {
  await assertRecordVisible(tx, tenant, typeKey, id)
  await requireRecordUpdate(tx, tenant, typeKey, id)
  await runRecordsPatchGuards(tx, { typeKey, recordId: id, fields })
  const before = await getRecord(tx, tenant, typeKey, id)
  const record = await applyFieldPatch(tx, tenant, typeKey, id, fields, {
    sharing: share ? 'confirmed' : 'ask'
  })
  return { record, changes: diffFields(defs, before.fields, record.fields) }
}

export const updateRecordTool = defineMcpTool({
  name: 'records_update',
  title: 'Update Record',
  description: 'Change fields on a record. Only the fields you pass change. Returns each changed field\'s value before and after, so the change can be shown and undone. To close a record use records_close; to change consent use crm_set_consent. To change several records, use records_update_many.',
  appId: 'records',
  scope: 'records.write',
  input: z.object({ org: orgInput, type: typeInput, id: idInput, fields: fieldsInput, share: shareInput }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, 'records.write', async (tx, tenant) => {
      const { defs, rules } = await typeContext(tx, tenant, input.type)
      const { record, changes } = await updateOne(tx, tenant, input.type, defs, input.id, input.fields, input.share)
      return text(`Updated ${record.name}. ${changeSummary(changes)}`, {
        record: recordOut(record, rules),
        changes
      })
    })
  }
})

const closeReasonInput = z.string().max(41).optional().describe('Reason option key, from the type\'s closedReasonField options.')
const closeStatusInput = z.string().max(41).optional().describe('Which closed status to use when the type has several. Defaults to the first.')

// The status (and reason) a close writes, checked against the type's closing rules.
function closePatch(
  typeKey: string,
  rules: ReturnType<typeof closingRulesOf>,
  status: string | undefined,
  reason: string | undefined
): Record<string, unknown> {
  if (!rules.statusKey || rules.closedStatuses.length === 0) {
    throw createError({ statusCode: 400, statusMessage: `${typeKey} records can't be closed: no status counts as closed.` })
  }
  const closed = status ?? rules.closedStatuses[0]!
  if (!rules.closedStatuses.includes(closed)) {
    throw createError({ statusCode: 400, statusMessage: `${closed} is not a closed status. Closed statuses: ${rules.closedStatuses.join(', ')}` })
  }
  if (reason && !rules.reasonKey) {
    throw createError({ statusCode: 400, statusMessage: `${typeKey} records have no reason field; close without a reason.` })
  }
  const patch: Record<string, unknown> = { [rules.statusKey]: closed }
  if (rules.reasonKey && reason !== undefined) patch[rules.reasonKey] = reason
  return patch
}

async function closeOne(
  tx: Tx,
  tenant: TenantContext,
  typeKey: string,
  defs: RecordsFieldSetting[],
  id: string,
  patch: Record<string, unknown>
) {
  await assertRecordVisible(tx, tenant, typeKey, id)
  await requireRecordUpdate(tx, tenant, typeKey, id)
  const before = await getRecord(tx, tenant, typeKey, id)
  const record = await applyFieldPatch(tx, tenant, typeKey, id, patch)
  return { record, changes: diffFields(defs, before.fields, record.fields) }
}

function revokesConsent(defs: RecordsFieldSetting[], rules: ReturnType<typeof closingRulesOf>, reason: string | undefined): boolean {
  const reasonDef = rules.reasonKey ? defs.find(d => d.key === rules.reasonKey) : undefined
  return !!reason && !!reasonDef?.options?.[reason]?.revokesConsent
}

export const closeRecordTool = defineMcpTool({
  name: 'records_close',
  title: 'Close Record',
  description: 'Close (archive) a record by setting a closed status — for a task, mark it done. When the type has a reason field, a reason is required (see closedReasonField in records_list_types). A reason marked revokesConsent (e.g. "asked to be removed") also turns off every consent on the record\'s addresses, including for other records that share them. Reopen a record by setting an open status with records_update. To close several records, use records_close_many.',
  appId: 'records',
  scope: 'records.write',
  input: z.object({
    org: orgInput,
    type: typeInput,
    id: idInput,
    reason: closeReasonInput,
    status: closeStatusInput
  }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, 'records.write', async (tx, tenant) => {
      const { defs, rules } = await typeContext(tx, tenant, input.type)
      const patch = closePatch(input.type, rules, input.status, input.reason)
      const { record, changes } = await closeOne(tx, tenant, input.type, defs, input.id, patch)
      const revoked = revokesConsent(defs, rules, input.reason)
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
  description: 'Add a note to a record\'s timeline, e.g. "Met on Sunday, wants to help with the youth group." The body is Markdown, like a rich_text field.',
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

// ─── Attachment uploads ─────────────────────────────────────────────────────
// Two steps, so the bytes go straight to storage: begin hands out a presigned
// PUT URL, complete puts the stored file on the field. Both check what the
// attachments route checks.

const attachmentFieldInput = z.string().min(1).max(64)
  .describe('Key of an attachments (files) field on the type, from records_list_types.')

async function attachmentsFieldOf(tx: Tx, tenant: TenantContext, typeKey: string, id: string, fieldKey: string) {
  const context = await typeContext(tx, tenant, typeKey)
  await assertRecordVisible(tx, tenant, typeKey, id)
  await requireRecordUpdate(tx, tenant, typeKey, id)
  const def = context.defs.find(d => d.key === fieldKey)
  if (!def || def.kind !== 'attachments') {
    throw createError({ statusCode: 400, statusMessage: `${fieldKey}: not an attachments field of ${typeKey}` })
  }
  return { ...context, def }
}

export const beginAttachmentUploadTool = defineMcpTool({
  name: 'records_begin_attachment_upload',
  title: 'Start File Upload',
  description: `Start adding a file (max ${RECORDS_ATTACHMENT_MAX_MB} MB) to a record's attachments field. Returns a presigned uploadUrl. Next: PUT the raw bytes to uploadUrl with the file's Content-Type within the hour (e.g. \`curl -X PUT -H 'Content-Type: <mime>' -T <path> "<uploadUrl>"\`), then call records_complete_attachment_upload with the returned key.`,
  appId: 'records',
  scope: 'records.write',
  input: z.object({
    org: orgInput,
    type: typeInput,
    id: idInput,
    field: attachmentFieldInput,
    filename: z.string().trim().min(1).max(255),
    mime: z.string().min(1).max(255).describe('The file\'s type, e.g. "image/png" or "application/pdf".'),
    size: z.number().int().min(0).describe('File size in bytes.')
  }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, 'records.write', async (tx, tenant) => {
      await attachmentsFieldOf(tx, tenant, input.type, input.id, input.field)
      const upload = await beginRecordAttachmentUpload(tx, input.id, input.field, {
        filename: input.filename,
        mime: input.mime,
        size: input.size
      })
      return text(`PUT the file to uploadUrl, then call records_complete_attachment_upload with key ${upload.key}.`, {
        uploadUrl: upload.uploadUrl,
        key: upload.key,
        expiresAt: upload.expiresAt.toISOString(),
        method: 'PUT',
        headers: { 'Content-Type': input.mime }
      })
    })
  }
})

export const completeAttachmentUploadTool = defineMcpTool({
  name: 'records_complete_attachment_upload',
  title: 'Finish File Upload',
  description: 'Finish a file started with records_begin_attachment_upload, after its bytes were PUT to uploadUrl: puts it last on the record\'s attachments field and notes the change on the timeline. Pass the same type, id and field as the begin call. A key works once.',
  appId: 'records',
  scope: 'records.write',
  input: z.object({
    org: orgInput,
    type: typeInput,
    id: idInput,
    field: attachmentFieldInput,
    key: z.string().min(1).max(512).describe('The key records_begin_attachment_upload returned.'),
    filename: z.string().trim().min(1).max(255).describe('The name the file shows under.')
  }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, 'records.write', async (tx, tenant) => {
      const { defs, rules, def } = await attachmentsFieldOf(tx, tenant, input.type, input.id, input.field)
      const before = await getRecord(tx, tenant, input.type, input.id)
      const file = await completeRecordAttachmentUpload(tx, tenant, input.id, def.key, {
        key: input.key,
        filename: input.filename
      })
      await tx.updateTable('records_entries').set({ updated_at: new Date() }).where('id', '=', input.id).execute()
      const record = await getRecord(tx, tenant, input.type, input.id)
      await recordRecordsActivity(tx, tenant, input.id, 'field_changed', {
        fieldKey: def.key,
        old: activityValue(def, before.fields[def.key] ?? []),
        new: activityValue(def, record.fields[def.key] ?? [])
      })
      return text(`Added ${file.name} to ${def.label} on ${record.name}.`, {
        file,
        record: recordOut(record, rules),
        changes: diffFields(defs, before.fields, record.fields)
      })
    })
  }
})

// ─── Bulk write tools ───────────────────────────────────────────────────────
// Each item runs in its own savepoint, so one that fails rolls back alone. A
// share refusal on any item refuses the whole call, so every share is confirmed at once.

const BULK_MAX = 100

type Outcome<R> = { ok: true, value: R } | { ok: false, error: unknown }

async function eachInSavepoint<I, R>(tx: Tx, items: I[], fn: (item: I) => Promise<R>): Promise<Outcome<R>[]> {
  const out: Outcome<R>[] = []
  for (const item of items) {
    await sql`savepoint records_bulk_item`.execute(tx)
    try {
      const value = await fn(item)
      await sql`release savepoint records_bulk_item`.execute(tx)
      out.push({ ok: true, value })
    } catch (error) {
      await sql`rollback to savepoint records_bulk_item`.execute(tx)
      out.push({ ok: false, error })
    }
  }
  return out
}

function errorText(error: unknown): string {
  return mcpError(error).content.map(c => c.text).join(' ')
}

function refuseUnconfirmedShares(outcomes: Outcome<unknown>[], labels: string[]): void {
  const refused = outcomes.flatMap((o, i) =>
    !o.ok && (o.error as { data?: { code?: string } } | null)?.data?.code === RECORDS_SHARE_CONFIRMATION
      ? [`${labels[i]}: ${errorText(o.error)}`]
      : [])
  if (refused.length === 0) return
  throw createError({
    statusCode: 409,
    statusMessage: `Nothing was saved: ${refused.length} of these would share a record with people who can't see it yet. Confirm with the user, then resend with share: true. ${refused.join(' ')}`
  })
}

function bulkSummary(verb: string, done: number, total: number, unchanged: number, failures: string[]): string {
  const parts = [`${verb} ${done} of ${total}.`]
  if (unchanged > 0) parts.push(`${unchanged} had nothing to change.`)
  if (failures.length > 0) parts.push(`${failures.length} failed: ${failures.join('; ')}`)
  return parts.join(' ')
}

export const createRecordsTool = defineMcpTool({
  name: 'records_create_many',
  title: 'Create Records',
  description: `Create several records of one type in one call, e.g. the tasks from a meeting or the rows of a list. Use it instead of repeated records_create calls. Each entry is { fields }, as records_create takes them; fields.name is required. Records are created in order and reported one by one with their new ids: one that fails comes back with status "error" and the rest are still created. If any would share a record with someone who can't see it yet, nothing is created and the call says who; confirm with the user, then resend with share: true. Up to ${BULK_MAX} records per call.`,
  appId: 'records',
  scope: 'records.write',
  input: z.object({
    org: orgInput,
    type: typeInput,
    records: z.array(z.object({ fields: fieldsInput }).strict()).min(1).max(BULK_MAX),
    share: shareInput
  }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, 'records.write', async (tx, tenant) => {
      await requireTypePermission(tx, tenant, input.type, 'create')
      await requireRecordType(tx, input.type, tenant)
      const outcomes = await eachInSavepoint(tx, input.records, r => applyFieldPatch(tx, tenant, input.type, null, r.fields, {
        sharing: input.share ? 'confirmed' : 'ask'
      }))
      const labels = input.records.map((r, i) => typeof r.fields.name === 'string' && r.fields.name ? `"${r.fields.name}"` : `#${i + 1}`)
      refuseUnconfirmedShares(outcomes, labels)
      const results = outcomes.map((o, i) => o.ok
        ? { index: i, id: o.value.id, name: o.value.name, status: 'created' as const }
        : { index: i, status: 'error' as const, error: errorText(o.error) })
      const failures = results.flatMap((r, i) => r.status === 'error' ? [`${labels[i]}: ${r.error}`] : [])
      return text(bulkSummary('Created', results.length - failures.length, results.length, 0, failures), { results })
    })
  }
})

export const updateRecordsTool = defineMcpTool({
  name: 'records_update_many',
  title: 'Update Records',
  description: `Change fields on several records of one type in one call. Use it instead of repeated records_update calls whenever more than a couple of records change. Each update is { id, fields }; only the fields passed change, and every update may pass the same fields. Updates apply in order and are reported one by one: one that fails (not found, no edit access, a bad value) comes back with status "error" and the rest still save. Returns each record's changed fields before and after. If any update would share a record with someone who can't see it yet, nothing is saved and the call says who; confirm with the user, then resend with share: true. Up to ${BULK_MAX} updates per call. To close records use records_close_many.`,
  appId: 'records',
  scope: 'records.write',
  input: z.object({
    org: orgInput,
    type: typeInput,
    updates: z.array(z.object({ id: idInput, fields: fieldsInput }).strict()).min(1).max(BULK_MAX),
    share: shareInput
  }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, 'records.write', async (tx, tenant) => {
      const { defs } = await typeContext(tx, tenant, input.type)
      const outcomes = await eachInSavepoint(tx, input.updates, u =>
        updateOne(tx, tenant, input.type, defs, u.id, u.fields, input.share))
      refuseUnconfirmedShares(outcomes, input.updates.map(u => u.id))
      const results = outcomes.map((o, i) => o.ok
        ? {
            id: o.value.record.id,
            name: o.value.record.name,
            status: o.value.changes.length > 0 ? 'updated' as const : 'unchanged' as const,
            changes: o.value.changes
          }
        : { id: input.updates[i]!.id, status: 'error' as const, error: errorText(o.error) })
      const updated = results.filter(r => r.status === 'updated').length
      const unchanged = results.filter(r => r.status === 'unchanged').length
      const failures = results.flatMap(r => r.status === 'error' ? [`${r.id}: ${r.error}`] : [])
      return text(bulkSummary('Updated', updated, results.length, unchanged, failures), { results })
    })
  }
})

export const closeRecordsTool = defineMcpTool({
  name: 'records_close_many',
  title: 'Close Records',
  description: `Close several records of one type in one call, all with the same closed status and reason: for tasks, mark them done. Use it instead of repeated records_close calls. The rules are records_close's: when the type has a reason field, a reason is required, and a reason marked revokesConsent turns off every consent on each record's addresses. Records close in order and are reported one by one: one that fails comes back with status "error" and the rest still close. Up to ${BULK_MAX} ids per call.`,
  appId: 'records',
  scope: 'records.write',
  input: z.object({
    org: orgInput,
    type: typeInput,
    ids: z.array(idInput).min(1).max(BULK_MAX),
    reason: closeReasonInput,
    status: closeStatusInput
  }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, 'records.write', async (tx, tenant) => {
      const { defs, rules } = await typeContext(tx, tenant, input.type)
      const patch = closePatch(input.type, rules, input.status, input.reason)
      const ids = [...new Set(input.ids)]
      const outcomes = await eachInSavepoint(tx, ids, id => closeOne(tx, tenant, input.type, defs, id, patch))
      const results = outcomes.map((o, i) => o.ok
        ? {
            id: ids[i]!,
            name: o.value.record.name,
            status: o.value.changes.length > 0 ? 'closed' as const : 'unchanged' as const,
            changes: o.value.changes
          }
        : { id: ids[i]!, status: 'error' as const, error: errorText(o.error) })
      const closed = results.filter(r => r.status === 'closed').length
      const unchanged = results.filter(r => r.status === 'unchanged').length
      const failures = results.flatMap(r => r.status === 'error' ? [`${r.id}: ${r.error}`] : [])
      const revoked = closed > 0 && revokesConsent(defs, rules, input.reason)
      return text(
        `${bulkSummary('Closed', closed, results.length, unchanged, failures)}${revoked ? ' Consent on the closed records\' addresses was revoked.' : ''}`,
        { results, consentRevoked: revoked }
      )
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
  target: z.string().max(41).optional().describe('Connection fields only: the record type it links to, e.g. "milestones".'),
  nesting: z.enum(['parent', 'children']).optional().describe('Connection fields only: makes the link a hierarchy. "children" puts the linked records under this type\'s records (a deliverable\'s tasks); "parent" puts this type\'s records under the linked one. The matching field is added to the other type, and whoever can see a record sees what sits under it.')
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
    target: spec.target,
    nesting: spec.nesting
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

const optionsPatchInput = z.record(
  z.string().regex(RECORDS_OPTION_KEY_RE),
  z.object({
    label: z.string().trim().min(1).max(80).optional(),
    color: z.string().max(20).optional(),
    closed: z.boolean().optional().describe('Status field only: whether this status closes the record (done, abandoned). A status keeps at least one open and one closed option.')
  }).strict()
).describe('Choices keyed by option key (lowercase slug). A new choice needs a label; for an existing one pass only what changes.')

export const updateFieldTool = defineMcpTool({
  name: 'records_update_field',
  title: 'Update Field',
  description: 'Rename a field, add or relabel choices of a dropdown, multi-select, tags or status field — e.g. add a new quarter to a milestones field — mark which statuses close a record, or put the choices in order. Pass only what changes; options you pass are added or changed, others stay.',
  appId: 'records',
  scope: 'records.schema.manage',
  input: z.object({
    org: orgInput,
    type: typeInput,
    field: z.string().max(41).describe('The field key.'),
    label: z.string().trim().min(1).max(80).optional(),
    options: optionsPatchInput.optional(),
    optionOrder: z.array(z.string().regex(RECORDS_OPTION_KEY_RE)).max(100).optional().describe('Option keys in display order (a status field\'s order is its board\'s column order); keys left out follow in their current order.')
  }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, 'records.schema.manage', async (tx, tenant) => {
      const type = await getRecordType(tx, input.type)
      if (!type || type.orphan) throw createError({ statusCode: 404, statusMessage: `Unknown record type: ${input.type}` })
      const current = (await getRecordTypeFields(tx, input.type)).find(f => f.key === input.field && !f.orphan)
      if (!current) throw createError({ statusCode: 404, statusMessage: `${input.type} has no field ${input.field}` })
      const options = input.options
        ? {
            ...(current.options ?? {}),
            ...Object.fromEntries(Object.entries(input.options).map(([key, patch]) => [key, { ...current.options?.[key], ...patch } as RecordsFieldOption]))
          }
        : undefined
      const field = await updateField(tx, tenant, input.type, input.field, {
        ...(input.label ? { label: input.label } : {}),
        ...(options ? { options } : {}),
        ...(input.optionOrder ? { optionOrder: input.optionOrder } : {})
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

export const updateRecordTypeTool = defineMcpTool({
  name: 'records_update_type',
  title: 'Update Record Type',
  description: 'Rename a record type, change its icon, or set which date field says when its records are due. A type with a due date gets Reminder and Repeat fields (see records_list_types → dueField).',
  appId: 'records',
  scope: 'records.schema.manage',
  input: z.object({
    org: orgInput,
    type: typeInput,
    label: z.string().trim().min(1).max(80).optional().describe('Plural label, e.g. "Events".'),
    labelSingular: z.string().trim().min(1).max(80).optional(),
    icon: z.string().max(80).optional().describe('A Lucide icon name, e.g. "i-lucide-calendar".'),
    dueField: z.string().max(41).nullable().optional().describe('Key of a date or date-and-time field holding when a record is due; null removes the due date.')
  }).strict(),
  handler: async (input, ctx) => {
    return await run(ctx, input.org, 'records.schema.manage', async (tx, tenant) => {
      const type = await updateRecordType(tx, tenant, input.type, {
        ...(input.label ? { label: input.label } : {}),
        ...(input.labelSingular ? { labelSingular: input.labelSingular } : {}),
        ...(input.icon ? { icon: input.icon } : {}),
        ...(input.dueField !== undefined ? { dueField: input.dueField } : {})
      })
      return text(`Updated ${type.label}.`, {
        type: { key: type.key, label: type.label, labelSingular: type.labelSingular, icon: type.icon ?? null, dueField: type.dueField ?? null }
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
  createRecordsTool,
  updateRecordsTool,
  closeRecordsTool,
  addCommentTool,
  beginAttachmentUploadTool,
  completeAttachmentUploadTool,
  createRecordTypeTool,
  addFieldTool,
  updateFieldTool,
  updateRecordTypeTool
]
