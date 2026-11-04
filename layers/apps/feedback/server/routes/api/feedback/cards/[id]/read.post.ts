// POST /api/feedback/cards/:id/read — mark the caller's notifications about
// this card read. The board calls it when a card is opened.
import { getRouterParam } from 'h3'
import { withOrgPermission } from '#tenant/server'
import { markCardNotificationsRead } from '../../../../../utils/notify-recipients'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' })

  return await withOrgPermission(event, { appId: 'feedback' }, 'feedback.read', async (tx, ctx) => {
    await markCardNotificationsRead(tx, ctx.userId, id)
    return { ok: true }
  })
})
