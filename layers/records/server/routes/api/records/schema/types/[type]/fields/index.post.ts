// POST /api/records/schema/types/:type/fields
// Creates an admin-defined custom field (a records_fields row with kind
// set) on any non-orphan record type — code-declared types take custom
// fields too. Kind is locked after create; only kinds whose storage resolves
// to jsonb, entries, connection edges or a storage driver are allowed
// (connection requires a target record type, communication_channel a
// channelType from the merged catalog). Returns { field } in the same shape as
// GET /api/records/schema/types/:type/fields entries. 409 on key collision with
// a manifest or existing custom field. Permission: records.schema.manage.

import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { createField, RECORDS_SCHEMA_SLUG_RE, RECORDS_ADMIN_FIELD_KINDS } from '#records/server'

const Option = z.object({
  label: z.string().trim().min(1).max(60),
  color: z.enum(['primary', 'secondary', 'success', 'info', 'warning', 'error', 'neutral']).optional(),
  description: z.string().trim().max(200).optional(),
  deleted: z.boolean().optional(),
  // Status options only.
  closed: z.boolean().optional(),
  // Code-owned: accepted so merged options round-trip, then dropped.
  revokesConsent: z.boolean().optional()
}).strict()

const Body = z.object({
  fieldKey: z.string().regex(RECORDS_SCHEMA_SLUG_RE, 'Must be a slug: [a-z][a-z0-9_]{1,40}'),
  kind: z.enum(RECORDS_ADMIN_FIELD_KINDS),
  label: z.string().trim().min(1).max(80),
  icon: z.string().trim().min(1).max(80).optional(),
  section: z.string().trim().min(1).max(60).optional(),
  required: z.boolean().optional(),
  options: z.record(z.string(), Option).optional(),
  // communication_channel only; must exist in the merged channel-type catalog.
  channelType: z.string().trim().min(1).max(60).optional(),
  // connection only; an existing record type key.
  target: z.string().trim().min(1).max(41).optional()
})

export default defineEventHandler(async (event) => {
  const typeKey = getRouterParam(event, 'type')!
  return await withOrgPermission(event, { appId: 'records' }, 'records.schema.manage', async (tx, ctx) => {
    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }

    const field = await createField(tx, ctx, typeKey, parsed.data)
    return {
      field: {
        key: field.key,
        kind: field.kind,
        label: field.label,
        icon: field.icon ?? null,
        section: field.section ?? null,
        required: field.required,
        hidden: field.hidden,
        order: field.order,
        options: field.options ?? null,
        custom: field.custom,
        orphan: field.orphan,
        channelType: field.channelType ?? null,
        target: field.target ?? null,
        multiple: field.multiple ?? false,
        column: field.column ?? null
      }
    }
  })
})
