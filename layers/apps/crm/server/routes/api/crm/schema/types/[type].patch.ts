// PATCH /api/crm/schema/types/:type
// Updates a record type's presentation: label/labelSingular/icon (null
// reverts a code type to its manifest value), hidden, and sectionOrder
// (stored in config; null clears), and closedReasonField (the key_select
// that holds why a closed record was closed; null reverts to the code
// default). For code-declared types only actual
// overrides are persisted; for custom types the row is the definition.
// Returns { type } in the GET summary shape. Permission: crm.schema.manage.

import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { updateRecordType } from '#crm/server'

const Body = z.object({
  label: z.string().trim().min(1).max(80).nullish(),
  labelSingular: z.string().trim().min(1).max(80).nullish(),
  icon: z.string().trim().min(1).max(80).nullish(),
  hidden: z.boolean().optional(),
  sectionOrder: z.array(z.string().trim().min(1).max(60)).max(50).nullish(),
  closedReasonField: z.string().trim().min(1).max(41).nullish()
})

export default defineEventHandler(async (event) => {
  const typeKey = getRouterParam(event, 'type')!
  return await withOrgPermission(event, { appId: 'crm' }, 'crm.schema.manage', async (tx, ctx) => {
    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }

    const type = await updateRecordType(tx, ctx, typeKey, parsed.data)
    return {
      type: {
        key: type.key,
        label: type.label,
        labelSingular: type.labelSingular,
        icon: type.icon ?? null,
        hidden: type.hidden,
        custom: type.custom,
        orphan: type.orphan,
        statusField: type.statusField ?? null,
        closedReasonField: type.closedReasonField ?? null
      }
    }
  })
})
