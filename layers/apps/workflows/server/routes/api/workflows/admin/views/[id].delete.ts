// DELETE /api/workflows/admin/views/:id — operator-admin delete of any
// view. Shares and placements cascade.
import { requireOperatorAdmin, withOrgContext } from '#tenant/server'

export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)
  const viewId = getRouterParam(event, 'id')!
  return await withOrgContext(event, { appId: 'workflows' }, async (tx) => {
    const deleted = await tx
      .deleteFrom('workflows_views')
      .where('id', '=', viewId)
      .executeTakeFirst()
    if (Number(deleted.numDeletedRows) === 0) {
      throw createError({ statusCode: 404, statusMessage: 'View not found' })
    }
    return { ok: true }
  })
})
