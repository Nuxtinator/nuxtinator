// POST /api/inbox/conversations/:id/draft-reply
// Two intents, keyed on the body:
//   generate (no `save`) → run the model and RETURN the draft without persisting
//                          (the modal's generate/refine loop leaves no stray
//                          drafts). `preview` is implied.
//   save (`save` present) → persist the reviewer's chosen draft verbatim (no
//                          generation) as a shared ai_generated draft, reusing
//                          the AI draft slot on regenerate (draftId) but NEVER
//                          overwriting a human draft (the ai_generated guard
//                          falls through to creating a new one).
// Gated by inbox.send; 503 when AI is not configured.
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { isAiConfigured, resolveFeatureModel } from '#ai/server'
import { INBOX_AI_DRAFT_FEATURE } from '../../../../../utils/inbox-ai-draft'
import type { InboxAiDraftMetadata } from '../../../../../database/schema'

const Body = z.object({
  fromIdentity: z.enum(['personal', 'contact']).optional(),
  draftId: z.string().uuid().optional(),
  // generate inputs
  direction: z.string().optional(),
  baseDraft: z.string().optional(),
  // save intent: the reviewed draft to persist verbatim
  save: z.object({
    html: z.string(),
    text: z.string().optional(),
    language: z.string().optional(),
    gloss: z.string().optional(),
    sources: z.array(z.string()).optional(),
    uncertainty: z.array(z.string()).optional()
  }).optional()
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  return await withOrgPermission(event, { appId: 'inbox' }, 'inbox.send', async (tx, ctx) => {
    if (!(await isAiConfigured(tx))) {
      throw createError({ statusCode: 503, statusMessage: 'AI drafting is not configured' })
    }
    const conversation = await inboxGetConversation(tx, id)
    if (!conversation) throw createError({ statusCode: 404, statusMessage: 'Conversation not found' })

    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }
    const { fromIdentity, draftId, save } = parsed.data

    // --- generate: run the model, return the draft (no persistence). ---
    if (!save) {
      const direction = parsed.data.direction?.trim().slice(0, 2000) || undefined
      const baseDraft = parsed.data.baseDraft?.trim().slice(0, 20_000) || undefined
      const draft = await generateInboxDraft(tx, ctx, id, { direction, baseDraft })
      return { preview: true as const, ...draft }
    }

    // --- save: persist the reviewer's chosen draft verbatim. ---
    const html = inboxSanitizeEmailHtml(save.html)
    const text = (save.text ?? inboxHtmlToText(html)).trim()

    // From identity: snapshot the personal alias onto the draft row; contact
    // resolves at send.
    let fromEmail: string | null = null
    if (fromIdentity === 'personal') {
      const settings = await getInboxSettings(tx)
      const { personalFrom } = await inboxResolvePersonalIdentity(tx, ctx.userId, settings)
      fromEmail = personalFrom ?? null
    }

    const meta: InboxAiDraftMetadata = {
      gloss: save.gloss ?? '',
      language: save.language ?? 'en',
      sources: save.sources ?? [],
      uncertainty: save.uncertainty ?? [],
      model: await resolveFeatureModel(tx, INBOX_AI_DRAFT_FEATURE)
    }

    // Regenerate into the same AI draft slot when the id is an AI draft on this
    // conversation; the DB guard (ai_generated = true) protects human drafts.
    if (draftId) {
      const updated = await inboxUpdateAiDraft(tx, {
        id: draftId,
        conversationId: id,
        bodyHtml: html,
        bodyText: text,
        fromEmail,
        aiMetadata: meta
      })
      if (updated) {
        await inboxLogConversationEvent(tx, id, 'inbox_ai_draft_saved', 'AI draft generated', {
          userId: ctx.userId,
          extra: { messageId: updated.id, regenerated: true, model: meta.model }
        })
        return { id: updated.id, status: 'draft' as const, ai: true as const }
      }
      // Not an AI draft (human-authored / missing) — fall through and create new.
    }

    const replySubject = conversation.subject ? `Re: ${conversation.subject.replace(/^Re:\s*/i, '')}` : null
    const created = await inboxCreateAiDraft(tx, {
      conversationId: id,
      senderUserId: ctx.userId,
      bodyHtml: html,
      bodyText: text,
      subject: replySubject,
      fromEmail,
      aiMetadata: meta
    })
    await inboxLogConversationEvent(tx, id, 'inbox_ai_draft_saved', 'AI draft generated', {
      userId: ctx.userId,
      extra: { messageId: created.id, model: meta.model }
    })
    return { id: created.id, status: 'draft' as const, ai: true as const }
  })
})
