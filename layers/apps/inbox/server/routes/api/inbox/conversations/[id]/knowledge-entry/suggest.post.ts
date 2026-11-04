// POST /api/inbox/conversations/:id/knowledge-entry/suggest
// Extract an anonymised Q&A proposal from a resolved thread. PROPOSES ONLY —
// nothing is persisted; the reviewer sees the stripped-PII list and saves via
// the knowledge-entries endpoint. Gated by inbox.send; 503 when AI is unconfigured.
import { withOrgPermission } from '#tenant/server'
import { isAiConfigured } from '#ai/server'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  return await withOrgPermission(event, { appId: 'inbox' }, 'inbox.send', async (tx) => {
    if (!(await isAiConfigured(tx))) {
      throw createError({ statusCode: 503, statusMessage: 'AI is not configured' })
    }
    const conversation = await inboxGetConversation(tx, id)
    if (!conversation) throw createError({ statusCode: 404, statusMessage: 'Conversation not found' })

    return await extractInboxKnowledgeEntry(tx, id)
  })
})
