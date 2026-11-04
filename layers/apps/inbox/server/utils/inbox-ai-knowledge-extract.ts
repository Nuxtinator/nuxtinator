// AI knowledge extraction. Converts a resolved thread into ONE anonymised Q&A
// entry via a forced `submit_knowledge_entry` tool call. PROPOSES only — the
// endpoint never persists the result directly (a human reviews the PII shield
// first). Kernel-style; the `#ai/server` client stubs the network under VITEST.
import { createError } from 'h3'
import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import { generate } from '#ai/server'
import { inboxGetConversation } from './inbox-conversations'
import { inboxListMessages, inboxAiContextMessages } from './inbox-messages'
import { inboxMessageText } from './inbox-ai-draft'

type Tx = Transaction<Database>

// The `#ai/server` feature key for the extraction model choice.
export const INBOX_AI_KNOWLEDGE_FEATURE = 'inbox.knowledge'

export interface InboxKnowledgeExtractResult {
  question: string
  answer: string
  language: string
  // Types of personal information stripped (surfaced to the reviewer).
  removed: string[]
}

const SYSTEM_PROMPT = `You convert a resolved support email thread into ONE reusable, fully ANONYMISED question-and-answer entry for an internal knowledge base. The entry will be reference material for drafting future replies to similar questions — so generalise it and remove anything personal.

Produce, via the submit_knowledge_entry tool:
- question: a generalised version of what the contact was asking, with every personal detail removed (no names, no specifics that identify the person or their organisation).
- answer: the team's answer, cleaned and generalised, accurate and reusable. Do NOT invent facts that weren't in the thread; keep only what was actually said.
- language: ISO code of the answer's language (e.g. 'en').
- removed: list each TYPE of personal information you stripped (e.g. "first name", "email address", "company name", "city", "personal circumstance"). Empty array if there was none.

Strip ALL personally identifying information: names, email addresses, phone numbers, postal addresses, company/organisation names, specific locations, and any personal circumstances that could identify someone. When in doubt, generalise.`

const KNOWLEDGE_TOOL = {
  name: 'submit_knowledge_entry',
  description: 'Submit the anonymised knowledge-base entry',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'Generalised, anonymised question' },
      answer: { type: 'string', description: 'Generalised, anonymised reference answer' },
      language: { type: 'string', description: "ISO language code, e.g. 'en'" },
      removed: { type: 'array', items: { type: 'string' }, description: 'Types of personal information stripped' }
    },
    required: ['question', 'answer', 'language']
  }
}

export async function extractInboxKnowledgeEntry(tx: Tx, conversationId: string): Promise<InboxKnowledgeExtractResult> {
  const conversation = await inboxGetConversation(tx, conversationId)
  if (!conversation) throw createError({ statusCode: 404, statusMessage: 'Conversation not found' })

  // Held rows never reach AI context — see inboxAiContextMessages.
  const messages = inboxAiContextMessages(await inboxListMessages(tx, conversationId))
  const thread = messages
    .map(m => `${m.direction === 'inbound' ? 'CONTACT' : 'TEAM'}: ${inboxMessageText(m)}`)
    .join('\n\n')

  const { input } = await generate<Partial<InboxKnowledgeExtractResult>>({
    tx,
    feature: INBOX_AI_KNOWLEDGE_FEATURE,
    // Plain-string system (no caching — extraction runs rarely and per-thread).
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `SUBJECT: ${conversation.subject || '(none)'}\n\nTHREAD:\n${thread}` }],
    tool: KNOWLEDGE_TOOL,
    maxTokens: 2048,
    // Deterministic extraction; generate() drops temperature for models that
    // reject it.
    temperature: 0
  })

  const question = (input.question ?? '').trim()
  const answer = (input.answer ?? '').trim()
  if (!question || !answer) {
    throw createError({ statusCode: 502, statusMessage: 'The AI returned an empty knowledge entry — try again.' })
  }

  return {
    question,
    answer,
    language: input.language || 'en',
    removed: input.removed ?? []
  }
}
