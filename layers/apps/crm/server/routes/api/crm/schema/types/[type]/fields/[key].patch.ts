// PATCH /api/crm/schema/types/:type/fields/:key
// Updates a field's presentation: label (null reverts a manifest field to
// its code label), hidden, required, order, section, and options. Option
// values carry the option's full desired state (null removes the override /
// custom option). For manifest fields only actual overrides are persisted —
// per-option overrides and admin-added options land in config.options; for
// custom fields the row's own config is updated. Kind is immutable. Returns
// { field } in the fields-GET entry shape. Permission: crm.schema.manage.

import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { updateField } from '#crm/server'

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
  label: z.string().trim().min(1).max(80).nullish(),
  // null reverts a manifest field to its code icon / clears a custom field's.
  icon: z.string().trim().min(1).max(80).nullish(),
  hidden: z.boolean().optional(),
  required: z.boolean().nullish(),
  order: z.number().int().min(-100000).max(100000).nullish(),
  section: z.string().trim().min(1).max(60).nullish(),
  options: z.record(z.string(), Option.nullable()).optional()
})

export default defineEventHandler(async (event) => {
  const typeKey = getRouterParam(event, 'type')!
  const fieldKey = getRouterParam(event, 'key')!
  return await withOrgPermission(event, { appId: 'crm' }, 'crm.schema.manage', async (tx, ctx) => {
    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }

    const field = await updateField(tx, ctx, typeKey, fieldKey, parsed.data)
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
