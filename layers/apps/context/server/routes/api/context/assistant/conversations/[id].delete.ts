// DELETE /api/context/assistant/conversations/:id
// The owner can delete their conversation even once a portfolio it drew on is
// hidden from their teams.
import { withOrgPermission } from '#tenant/server'
import { deleteConversation } from '../../../../../utils/assistant-conversations'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.assistant.chat', async (tx, ctx) => {
    const id = getRouterParam(event, 'id') ?? ''
    const deleted = await deleteConversation(tx, id, ctx.userId)
    if (!deleted) {
      throw createError({ statusCode: 404, statusMessage: 'Conversation not found.' })
    }
    return { success: true }
  })
})
