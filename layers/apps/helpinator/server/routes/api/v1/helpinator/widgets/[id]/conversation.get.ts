// GET /api/v1/helpinator/widgets/:id/conversation — public, bearer session
// token. Restores the visitor's conversation from the server's transcript
// (the browser cache is only a display copy). A token with no live
// conversation (unknown, another widget's, or ended) answers 200 with
// `conversationId: null` = start fresh — an expected state, so it shouldn't
// surface as a failed request in the host page's console.
import { helpinatorWithWidget } from '../../../../../../utils/helpinator-public'
import { helpinatorBearer, helpinatorHashSessionToken } from '../../../../../../utils/helpinator-guards'
import {
  helpinatorFindSession,
  helpinatorIsLive,
  helpinatorListMessages,
  helpinatorPublicMessage
} from '../../../../../../utils/helpinator-conversations'

export default defineEventHandler(async (event) => {
  const token = helpinatorBearer(event)
  if (!token) throw createError({ statusCode: 401, statusMessage: 'Session token required' })
  return await helpinatorWithWidget(event, async (tx, widget) => {
    const conversation = await helpinatorFindSession(tx, widget.id, helpinatorHashSessionToken(token))
    if (!conversation || !helpinatorIsLive(conversation, widget)) {
      return { conversationId: null, messages: [], visitorEmail: null, handedOff: false }
    }
    const messages = await helpinatorListMessages(tx, conversation.id)
    return {
      conversationId: conversation.id,
      messages: messages.map(helpinatorPublicMessage),
      visitorEmail: conversation.visitor_email,
      handedOff: conversation.inbox_conversation_id !== null
    }
  })
})
