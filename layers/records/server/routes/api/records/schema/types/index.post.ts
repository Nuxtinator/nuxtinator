// POST /api/records/schema/types
// Creates an admin-defined record type (a records_types row with
// is_custom). The key is immutable after create — renames are label changes.
// Returns { type } in the same summary shape as GET /api/records/schema/types.
// 409 when the key collides with a code-declared or existing custom type.
// Permission: records.schema.manage.

import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { createRecordType, RECORDS_SCHEMA_SLUG_RE } from '#records/server'

const Body = z.object({
  typeKey: z.string().regex(RECORDS_SCHEMA_SLUG_RE, 'Must be a slug: [a-z][a-z0-9_]{1,40}'),
  label: z.string().trim().min(1).max(80),
  labelSingular: z.string().trim().min(1).max(80),
  icon: z.string().trim().min(1).max(80).optional()
})

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, 'records.schema.manage', async (tx, ctx) => {
    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }

    const type = await createRecordType(tx, ctx, parsed.data)
    return {
      type: {
        key: type.key,
        label: type.label,
        labelSingular: type.labelSingular,
        icon: type.icon ?? null,
        hidden: type.hidden,
        custom: type.custom,
        orphan: type.orphan,
        statusField: type.statusField ?? null
      }
    }
  })
})
