// PATCH /api/views/:id/values/:recordId — sets values of the view's own
// fields on one of its records: { values: { <fieldKey>: value } }, null
// clearing a field. An attachments field takes the files to keep, in order.
// Needs 'edit' on the view; the record must be in the view and visible to
// the caller. Returns { viewValues } — all of the record's values on the view.
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { requireView } from '../../../../../utils/views'
import { assertInView } from '../../../../../utils/placements'
import { readViewValues, setViewValues } from '../../../../../utils/view-fields'
import { requireRecordsWriteScope } from '../../../../../utils/view-records'

const Body = z.object({
  values: z.record(z.string(), z.unknown())
}).strict()

export default defineEventHandler(async (event) => {
  const viewId = getRouterParam(event, 'id')!
  const recordId = getRouterParam(event, 'recordId')!
  return await withOrgPermission(event, { appId: 'views' }, 'views.use', async (tx, ctx) => {
    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }
    requireRecordsWriteScope(ctx)
    const { view } = await requireView(tx, ctx, viewId, 'edit')
    await assertInView(tx, ctx, view, recordId)
    await setViewValues(tx, ctx, view, recordId, parsed.data.values)
    const values = await readViewValues(tx, view, [recordId])
    return { viewValues: values.get(recordId) ?? {} }
  })
})
