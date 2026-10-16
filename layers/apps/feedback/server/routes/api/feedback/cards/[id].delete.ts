import { getRouterParam } from 'h3'
import { withOrgPermission } from '#tenant/server'
import { logDelete } from '#core/server/utils/activity-logger'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' })

  return await withOrgPermission(event, { appId: 'feedback' }, 'feedback.write', async (tx, ctx) => {
    const card = await tx
      .selectFrom('cards')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()

    if (!card) throw createError({ statusCode: 404, statusMessage: 'Card not found' })

    await tx.deleteFrom('cards').where('id', '=', id).execute()

    logDelete('cards', id, ctx.userId, { title: card.title })
    return { success: true, card }
  })
})
