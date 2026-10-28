// PATCH /api/crm/records/:type/:id
// Body: { fields: { <fieldKey>: value } } — scalar fields take a value (null
// clears), multi-value fields take an array (replace) or the D.T-style
// { values: [{ value, delete? }], force_values? } list. Runs the kernel's
// field-patch pipeline and returns the updated hydrated detail with the
// caller's capability flags. Permission: the record-visibility rule plus the
// record-scoped update gate — the type evaluator's update answer OR an
// edit-level share on this record.

import { z } from 'zod'
import { withOrgContext } from '#tenant/server'
import {
  applyFieldPatch,
  assertRecordVisible,
  requireRecordType,
  requireRecordUpdate,
  resolveTypeCapabilities
} from '#crm/server'

const Body = z.object({
  fields: z.record(z.string(), z.unknown())
})

export default defineEventHandler(async (event) => {
  const typeKey = getRouterParam(event, 'type')!
  const id = getRouterParam(event, 'id')!
  return await withOrgContext(event, { appId: 'crm' }, async (tx, ctx) => {
    await requireRecordType(tx, typeKey)
    await assertRecordVisible(tx, ctx, typeKey, id)
    await requireRecordUpdate(tx, ctx, typeKey, id)

    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }

    const record = await applyFieldPatch(tx, ctx, typeKey, id, parsed.data.fields)
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
      // The update gate passed, so canEdit is true by construction (type
      // answer or edit share — either way this caller can edit this record).
      capabilities: { canEdit: true, canShare: caps.share, canDelete: caps.delete }
    }
  })
})
