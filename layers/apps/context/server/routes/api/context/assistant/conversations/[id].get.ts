// GET /api/context/assistant/conversations/:id
import { withOrgPermission } from '#tenant/server'
import { getOwnedConversationOr404, listMessages } from '../../../../../utils/assistant-conversations'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.assistant.chat', async (tx, ctx) => {
    const id = getRouterParam(event, 'id') ?? ''
    const conversation = await getOwnedConversationOr404(tx, id, ctx.userId)
    const messages = await listMessages(tx, conversation.id)
    return {
      conversation,
      messages,
      can_apply: ctx.perms.has('context.write') && ctx.perms.has('context.assistant.apply')
    }
  })
})
