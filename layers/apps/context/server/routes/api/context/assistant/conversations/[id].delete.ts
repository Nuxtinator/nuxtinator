// DELETE /api/context/assistant/conversations/:id
import { withOrgPermission } from '#tenant/server'
import { deleteConversation, getOwnedConversationOr404 } from '../../../../../utils/assistant-conversations'
import { getContextTeamScope } from '../../../../../utils/portfolio-helpers'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.assistant.chat', async (tx, ctx) => {
    const id = getRouterParam(event, 'id') ?? ''
    await getOwnedConversationOr404(tx, id, ctx.userId, await getContextTeamScope(event, tx, ctx))
    const deleted = await deleteConversation(tx, id, ctx.userId)
    if (!deleted) {
      throw createError({ statusCode: 404, statusMessage: 'Conversation not found.' })
    }
    return { success: true }
  })
})
