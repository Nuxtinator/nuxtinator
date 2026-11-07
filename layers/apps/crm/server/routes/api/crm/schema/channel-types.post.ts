// POST /api/crm/schema/channel-types
// Creates an admin-defined channel type. The value format comes from the
// five code-owned formats and is immutable after create (it drives
// normalization). 409 when the key collides with a code-registered or
// existing custom channel type. Returns { channelType } in the GET entry
// shape. Permission: records.schema.manage.

import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { RECORDS_SCHEMA_SLUG_RE } from '#records/server'
import { createChannelType, CRM_CHANNEL_VALUE_FORMATS } from '#crm/server'

const Body = z.object({
  typeKey: z.string().regex(RECORDS_SCHEMA_SLUG_RE, 'Must be a slug: [a-z][a-z0-9_]{1,40}'),
  label: z.string().trim().min(1).max(60),
  valueFormat: z.enum(CRM_CHANNEL_VALUE_FORMATS),
  icon: z.string().trim().min(1).max(80).optional()
})

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'crm' }, 'records.schema.manage', async (tx, ctx) => {
    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }

    const created = await createChannelType(tx, ctx, parsed.data)
    return {
      channelType: {
        key: created.typeKey,
        label: created.label,
        icon: created.icon ?? (typeof created.config.icon === 'string' ? created.config.icon : null),
        valueFormat: created.valueFormat,
        custom: created.custom
      }
    }
  })
})
