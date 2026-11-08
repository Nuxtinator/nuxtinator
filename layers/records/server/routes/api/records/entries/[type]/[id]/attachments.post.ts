// POST /api/records/entries/:type/:id/attachments?field=<key>
// multipart/form-data with one or more "file" parts. Uploads each file onto
// the record's attachments field (last, in the order sent), records the
// change on the timeline, and returns { files } — the field's files after
// the upload. Permission: the record-visibility rule plus the record-scoped
// update gate, like PATCH.

import { withOrgContext } from '#tenant/server'
import {
  activityValue,
  addRecordAttachment,
  assertRecordVisible,
  getRecord,
  getRecordTypeFields,
  recordRecordsActivity,
  requireRecordType,
  requireRecordUpdate
} from '#records/server'

export default defineEventHandler(async (event) => {
  const typeKey = getRouterParam(event, 'type')!
  const id = getRouterParam(event, 'id')!
  const fieldKey = String(getQuery(event).field ?? '')
  return await withOrgContext(event, async (tx, ctx) => {
    await requireRecordType(tx, typeKey, ctx)
    await assertRecordVisible(tx, ctx, typeKey, id)
    await requireRecordUpdate(tx, ctx, typeKey, id)
    const def = (await getRecordTypeFields(tx, typeKey)).find(f => f.key === fieldKey && !f.orphan)
    if (!def || def.kind !== 'attachments') {
      throw createError({ statusCode: 400, statusMessage: `${fieldKey || 'field'}: not an attachments field` })
    }

    const parts = (await readMultipartFormData(event))?.filter(p => p.name === 'file' && p.filename) ?? []
    if (parts.length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No "file" field in upload.' })
    }

    const before = (await getRecord(tx, ctx, typeKey, id)).fields[fieldKey] ?? []
    for (const part of parts) {
      await addRecordAttachment(tx, ctx, id, fieldKey, {
        data: Buffer.from(part.data),
        filename: part.filename ?? 'upload',
        mime: part.type ?? 'application/octet-stream'
      })
    }
    const after = (await getRecord(tx, ctx, typeKey, id)).fields[fieldKey] ?? []
    await tx.updateTable('records_entries').set({ updated_at: new Date() }).where('id', '=', id).execute()
    await recordRecordsActivity(tx, ctx, id, 'field_changed', {
      fieldKey,
      old: activityValue(def, before),
      new: activityValue(def, after)
    })
    return { files: after }
  })
})
