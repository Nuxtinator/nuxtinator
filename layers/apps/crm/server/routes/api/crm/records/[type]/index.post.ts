// POST /api/crm/records/:type
// Body: { fields: { <fieldKey>: value } } — `name` arrives as fields.name
// like any other field; multi-value fields take an array or the D.T-style
// { values: [...] } list. Runs the kernel's field-patch pipeline (validation,
// storage routing, activity) and returns the hydrated record detail with the
// caller's capability flags. Permission: the type evaluator's create answer.

import { z } from 'zod'
import { withOrgContext } from '#tenant/server'
import { accountOwnedChannelTypes } from '../../../../../utils/account-link'
import { applyFieldPatch, requireRecordType, requireTypePermission, resolveTypeCapabilities } from '#crm/server'

const Body = z.object({
  fields: z.record(z.string(), z.unknown())
})

export default defineEventHandler(async (event) => {
  const typeKey = getRouterParam(event, 'type')!
  return await withOrgContext(event, { appId: 'crm' }, async (tx, ctx) => {
    await requireTypePermission(tx, ctx, typeKey, 'create')
    await requireRecordType(tx, typeKey)

    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }

    const record = await applyFieldPatch(tx, ctx, typeKey, null, parsed.data.fields)
    const caps = await resolveTypeCapabilities(tx, ctx, typeKey)
    return {
      id: record.id,
      typeKey: record.recordType,
      name: record.name,
      status: record.status,
      fields: record.fields,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      createdBy: record.createdBy,
      userId: record.userId,
      accountOwnedChannelTypes: accountOwnedChannelTypes(record.userId),
      // A fresh record has no shares, so canEdit is the plain type answer.
      capabilities: { canEdit: caps.update, canShare: caps.share, canDelete: caps.delete }
    }
  })
})
