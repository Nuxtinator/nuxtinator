// POST /api/inbox/conversations/:id/messages
// Body: { body?, saveDraft?, draftId? }. One endpoint, four intents:
//   saveDraft, no draftId → create a shared draft
//   saveDraft + draftId    → update that draft (body only)
//   send, no draftId       → queue a fresh reply
//   send + draftId         → promote the draft to a queued send (merging the
//                            latest composer edits over the stored body)
// A send auto-assigns an unassigned conversation to the sender, flips it to
// 'pending' (waiting on the contact), and clears the needs-review flag; the
// message row lands 'queued' and the send sweep delivers it. A send to an
// undeliverable address is refused (409). Saving a draft does none of that —
// it only stores text.

import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'

const Body = z.object({
  body: z.string().max(500_000).optional(),
  saveDraft: z.boolean().optional(),
  draftId: z.string().uuid().optional(),
  // Which From address a send goes out on. 'personal' uses the sender's alias
  // (with a hard fallback to 'contact' when they have none); default 'contact'.
  fromIdentity: z.enum(['personal', 'contact']).optional()
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  return await withOrgPermission(event, { appId: 'inbox' }, 'inbox.send', async (tx, ctx) => {
    const conversation = await inboxGetConversation(tx, id)
    if (!conversation) {
      throw createError({ statusCode: 404, statusMessage: 'Conversation not found' })
    }
    if (conversation.status === 'spam') {
      throw createError({ statusCode: 400, statusMessage: 'Cannot reply to a spam conversation' })
    }

    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }
    const { saveDraft, draftId } = parsed.data
    const rawBody = parsed.data.body ?? ''
    const html = inboxSanitizeEmailHtml(rawBody)
    const text = inboxHtmlToText(html)
    const replySubject = conversation.subject ? `Re: ${conversation.subject.replace(/^Re:\s*/i, '')}` : null

    // --- Save / update a shared draft: store text, no send side effects. ---
    if (saveDraft) {
      // The From choice travels WITH the shared draft (a teammate picking it
      // up sees the saved identity): personal resolves to the caller's alias
      // snapshot, contact clears to the shared address, absent keeps the
      // stored choice. The signature is NOT baked here — that happens once,
      // at queue time.
      let fromEmail: string | null | undefined
      if (parsed.data.fromIdentity === 'personal') {
        const settings = await getInboxSettings(tx)
        const { personalFrom } = await inboxResolvePersonalIdentity(tx, ctx.userId, settings)
        fromEmail = personalFrom
      } else if (parsed.data.fromIdentity === 'contact') {
        fromEmail = null
      }
      if (draftId) {
        const updated = await inboxUpdateDraft(tx, { id: draftId, conversationId: id, bodyHtml: html, bodyText: text, fromEmail })
        if (!updated) throw createError({ statusCode: 404, statusMessage: 'Draft not found' })
        return { id: updated.id, status: 'draft' as const }
      }
      const draft = await inboxCreateDraft(tx, {
        conversationId: id,
        senderUserId: ctx.userId,
        bodyHtml: html,
        bodyText: text,
        subject: replySubject,
        fromEmail: fromEmail ?? null
      })
      return { id: draft.id, status: 'draft' as const }
    }

    // --- Send: promote an existing draft, or queue a fresh reply. ---
    const message = await inboxQueueReply(tx, conversation, ctx.userId, {
      rawBody,
      draftId,
      fromIdentity: parsed.data.fromIdentity
    })

    return { id: message.id, status: message.status }
  })
})
