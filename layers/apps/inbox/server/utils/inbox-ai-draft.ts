// AI draft-reply engine. Assembles the grounded prompt and forces a single
// `submit_draft` tool call through `#ai/server`. Kernel-style — takes a scope
// `tx` + tenant ctx, never imports `db`. Under VITEST the `#ai/server` client
// stubs the network boundary, so this returns a deterministic schema-shaped
// draft without a key.
import { createError } from 'h3'
import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import { generate } from '#ai/server'
import type { AiTextPart } from '#ai/server'
import { resolveTypePermission } from '#crm/server'
import { inboxGetConversation } from './inbox-conversations'
import { inboxListMessages, inboxAiContextMessages, type InboxMessageRow } from './inbox-messages'
import { getInboxStaticPack, getInboxKnowledgeBlock, formatInboxContactRecord } from './inbox-ai-grounding'

type Tx = Transaction<Database>
type CrmCtx = Parameters<typeof resolveTypePermission>[1]

// The `#ai/server` feature key — the admin AI page shows a model picker for it.
export const INBOX_AI_DRAFT_FEATURE = 'inbox.draft'

export interface InboxDraftResult {
  draft_language: string
  draft_html: string
  draft_text: string
  english_gloss: string
  sources_used: string[]
  uncertainty: string[]
}

const INSTRUCTIONS = `You draft email replies for a support team. A human teammate reviews and edits every draft before it is sent, so your job is to produce the best possible starting point — not a finished, auto-sent message.

Follow the VOICE & TONE GUIDE below exactly. Ground every organisation-specific fact in the provided material (the reference content, past team answers, and the contact's record). Never invent prices, dates, definitions, counts, or policies — if a needed fact is absent, leave a bracketed placeholder in the body and record it in uncertainty.

Language:
- Write the reply in the language the contact is using (infer it from their most recent message). Put that language code in draft_language.
- english_gloss must be a faithful, literal back-translation of the EXACT draft you wrote, so an English-only reviewer can verify it. If the draft is already in English, set english_gloss equal to the draft text.

Output ONLY by calling the submit_draft tool.`

const DRAFT_TOOL = {
  name: 'submit_draft',
  description: 'Submit the drafted reply for human review',
  parameters: {
    type: 'object',
    properties: {
      draft_language: { type: 'string', description: "ISO language code of the draft (e.g. 'en', 'es', 'fr')" },
      draft_html: { type: 'string', description: 'The reply body as simple HTML (paragraphs, lists, links). No signature.' },
      draft_text: { type: 'string', description: 'The same reply as plain text.' },
      english_gloss: { type: 'string', description: 'Faithful English back-translation of the exact draft (equal to the draft if already English).' },
      sources_used: { type: 'array', items: { type: 'string' }, description: 'Short labels of grounding pieces that informed the answer (e.g. "reference: pricing", "KB: refunds").' },
      uncertainty: { type: 'array', items: { type: 'string' }, description: 'Facts you were unsure about or bracketed placeholders the reviewer must fill in. Empty if none.' }
    },
    required: ['draft_language', 'draft_html', 'draft_text', 'english_gloss']
  }
}

// Prefer the stored plain text; fall back to a light HTML→text of the body so
// the model reads clean prose (email clients ignore <style>; we only need words).
export function inboxMessageText(m: Pick<InboxMessageRow, 'body_text' | 'body_html' | 'body_stripped_html'>): string {
  const text = m.body_text?.trim()
  if (text) return text
  const html = m.body_html || m.body_stripped_html || ''
  return html
    .replace(/<\s*(?:br\s*\/?|\/(?:p|h[1-6]|li|div|tr))\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function buildThread(messages: (InboxMessageRow & { sender_name: string | null })[]): string {
  if (!messages.length) return '(no prior messages)'
  return messages
    .map((m) => {
      const who = m.direction === 'inbound'
        ? `CONTACT (${m.from_name || m.from_email || 'unknown'})`
        : `TEAM (${m.sender_name || 'team'})`
      return `--- ${who} — ${String(m.created_at)} ---\n${inboxMessageText(m)}`
    })
    .join('\n\n')
}

// Transient provider errors — rate limits and upstream 5xx, which `#ai/server`
// surfaces as 429/5xx-status createErrors — get a short in-request retry with
// backoff before the reviewer ever sees a failure. Anything else (bad request,
// auth, feature disabled) throws immediately.
async function withTransientRetry<T>(fn: () => Promise<T>): Promise<T> {
  const delaysMs = [500, 1500]
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const status = (err as { statusCode?: number })?.statusCode ?? 0
      const transient = status === 429 || status >= 500
      if (!transient || attempt >= delaysMs.length) throw err
      await new Promise(resolve => setTimeout(resolve, delaysMs[attempt]))
    }
  }
}

export async function generateInboxDraft(
  tx: Tx,
  ctx: CrmCtx,
  conversationId: string,
  opts: { direction?: string, baseDraft?: string } = {}
): Promise<InboxDraftResult> {
  const conversation = await inboxGetConversation(tx, conversationId)
  if (!conversation) throw createError({ statusCode: 404, statusMessage: 'Conversation not found' })

  const [messages, contactRecord, staticPack, knowledgeBlock] = await Promise.all([
    // Held rows never reach AI context — see inboxAiContextMessages.
    inboxListMessages(tx, conversationId).then(inboxAiContextMessages),
    formatInboxContactRecord(tx, ctx, conversation.channel_id),
    getInboxStaticPack(tx, ctx.orgId),
    getInboxKnowledgeBlock(tx)
  ])

  const direction = opts.direction?.trim().slice(0, 2000)
  const baseDraft = opts.baseDraft?.trim().slice(0, 20000)

  // system = cacheable blocks (static pack first, knowledge second — separate
  // blocks so adding a KB entry doesn't bust the static-pack cache).
  const system: AiTextPart[] = [{ type: 'text', text: `${INSTRUCTIONS}\n\n${staticPack}`, cache: true }]
  if (knowledgeBlock) system.push({ type: 'text', text: knowledgeBlock, cache: true })

  const userSegments = [
    `CONTACT RECORD\n${contactRecord}`,
    `CONVERSATION SUBJECT: ${conversation.subject || '(none)'}`,
    `CONVERSATION THREAD (oldest first)\n${buildThread(messages)}`
  ]
  if (baseDraft) {
    userSegments.push(`CURRENT DRAFT (revise this rather than starting over — keep what works, preserve the content the instructions call for, and change only what they ask):\n${baseDraft}`)
  }
  if (direction) {
    userSegments.push(`INSTRUCTIONS FROM THE REVIEWING TEAMMATE (satisfy ALL of them together — a later instruction adds to the earlier ones and does not cancel them unless it directly contradicts one, in which case the later wins. Still follow the tone guide and ground every fact in the provided material):\n${direction}`)
  }
  userSegments.push(
    baseDraft
      ? 'Revise the current draft for the most recent CONTACT message. Call submit_draft with the result.'
      : 'Draft a reply to the most recent CONTACT message. Call submit_draft with the result.'
  )

  const { input } = await withTransientRetry(() => generate<Partial<InboxDraftResult>>({
    tx,
    feature: INBOX_AI_DRAFT_FEATURE,
    system,
    messages: [{ role: 'user', content: userSegments.join('\n\n') }],
    tool: DRAFT_TOOL,
    maxTokens: 8192,
    // generate() only forwards temperature to models that accept it.
    temperature: 0.4
  }))

  const draftHtml = (input.draft_html ?? '').trim()
  const draftText = (input.draft_text ?? '').trim()
  if (!draftHtml || !draftText) {
    throw createError({ statusCode: 502, statusMessage: 'The AI returned an empty draft — try again.' })
  }

  return {
    draft_language: input.draft_language || 'en',
    draft_html: draftHtml,
    draft_text: draftText,
    english_gloss: input.english_gloss || draftText,
    sources_used: input.sources_used ?? [],
    uncertainty: input.uncertainty ?? []
  }
}
