// POST /api/views/:id/values/:recordId/attachments?field=<key> —
// multipart/form-data with one or more "file" parts, added (last, in the
// order sent) to one of the view's own attachments fields on one of its
// records. Needs 'edit' on the view; the record must be in the view and
// visible to the caller. Returns { files } — the field's files after it.
import { withOrgPermission } from '#tenant/server'
import { addRecordAttachment } from '#records/server'
import { requireView } from '../../../../../../utils/views'
import { assertInView } from '../../../../../../utils/placements'
import { readViewValues, viewAttachmentKey, viewFieldsOf } from '../../../../../../utils/view-fields'
import { requireRecordsWriteScope } from '../../../../../../utils/view-records'

export default defineEventHandler(async (event) => {
  const viewId = getRouterParam(event, 'id')!
  const recordId = getRouterParam(event, 'recordId')!
  const fieldKey = String(getQuery(event).field ?? '')
  return await withOrgPermission(event, { appId: 'views' }, 'views.use', async (tx, ctx) => {
    requireRecordsWriteScope(ctx)
    const { view } = await requireView(tx, ctx, viewId, 'edit')
    const field = viewFieldsOf(view).find(f => f.key === fieldKey)
    if (!field || field.kind !== 'attachments') {
      throw createError({ statusCode: 400, statusMessage: `${fieldKey || 'field'}: not an attachments field of this view` })
    }
    await assertInView(tx, ctx, view, recordId)
    const parts = (await readMultipartFormData(event))?.filter(p => p.name === 'file' && p.filename) ?? []
    if (parts.length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No "file" field in upload.' })
    }
    for (const part of parts) {
      await addRecordAttachment(tx, ctx, recordId, viewAttachmentKey(view.id, field.key), {
        data: Buffer.from(part.data),
        filename: part.filename ?? 'upload',
        mime: part.type ?? 'application/octet-stream'
      })
    }
    const values = await readViewValues(tx, view, [recordId])
    return { files: values.get(recordId)?.[field.key] ?? [] }
  })
})
