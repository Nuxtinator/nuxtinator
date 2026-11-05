// DELETE /api/views/admin/:id — operator-admin delete of any
// view. Shares and placements cascade.
import { requireOperatorAdmin, withOrgContext } from '#tenant/server'

export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)
  const viewId = getRouterParam(event, 'id')!
  return await withOrgContext(event, { appId: 'views' }, async (tx) => {
    const deleted = await tx
      .deleteFrom('views_definitions')
      .where('id', '=', viewId)
      .executeTakeFirst()
    if (Number(deleted.numDeletedRows) === 0) {
      throw createError({ statusCode: 404, statusMessage: 'View not found' })
    }
    return { ok: true }
  })
})
