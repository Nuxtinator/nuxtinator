// DELETE /api/views/admin/:id — operator-admin delete of any view, with the
// records created on a hand-picked view that no other view holds, as the
// owner's delete does. Shares and placements cascade.
import { requireOperatorAdmin, withOrgContext } from '#tenant/server'
import { deleteViewWithOwnCards } from '../../../../utils/views'

export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)
  const viewId = getRouterParam(event, 'id')!
  return await withOrgContext(event, { appId: 'views' }, async (tx) => {
    const view = await tx
      .selectFrom('views_definitions')
      .select(['id', 'definition', 'record_type_key'])
      .where('id', '=', viewId)
      .executeTakeFirst()
    if (!view) throw createError({ statusCode: 404, statusMessage: 'View not found' })
    await deleteViewWithOwnCards(tx, view)
    return { ok: true }
  })
})
