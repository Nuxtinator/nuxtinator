// GET /api/helpinator/conversations/:id — one transcript, read-only, with the
// pages the bot read, the searches it ran and the pages they surfaced for each
// reply.
import { withOrgPermission } from '#tenant/server'
import { helpinatorAdminConversation, helpinatorGetConversationOr404 } from '../../../../utils/helpinator-admin'
import { helpinatorListMessages } from '../../../../utils/helpinator-conversations'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'helpinator' }, 'helpinator.access', async (tx) => {
    const conversation = await helpinatorGetConversationOr404(tx, getRouterParam(event, 'id') ?? '')
    const messages = await helpinatorListMessages(tx, conversation.id)
    return {
      conversation: helpinatorAdminConversation(conversation),
      messages: messages.map(m => ({
        id: m.id,
        role: m.role,
        content: m.content,
        model: m.model,
        created_at: m.created_at,
        pages_loaded: m.pages_loaded ?? [],
        searches: m.searches ?? [],
        search_hits: m.search_hits ?? []
      }))
    }
  })
})
