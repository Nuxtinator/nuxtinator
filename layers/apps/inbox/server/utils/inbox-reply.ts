// Queuing a staff reply. The composer route and the MCP send tool both send
// through inboxQueueReply, so a reply follows the same rules wherever it
// starts.
import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { InboxConversationRow } from './inbox-conversations'
import type { InboxMessageRow } from './inbox-messages'

type Tx = Transaction<Database>

// A reply is refused up front when it could only end up held or failed: the
// org has no shared contact address to send from, the conversation has no
// address to reply to, or that address carries a deliverability suppression.
export async function inboxAssertReplyDeliverable(
  tx: Tx,
  conversation: Pick<InboxConversationRow, 'channel_id'>
): Promise<void> {
  const settings = await getInboxSettings(tx)
  if (!settings.contactAddress) {
    throw createError({ statusCode: 409, statusMessage: 'The inbox has no sending address configured' })
  }
  const status = await inboxGetReplyStatus(tx, conversation)
  if (!status.email) {
    throw createError({ statusCode: 409, statusMessage: 'This conversation has no address to reply to' })
  }
  if (status.suppression) {
    throw createError({
      statusCode: 409,
      statusMessage: `The recipient address is suppressed (${status.suppression.reason}); replies to it cannot be delivered`
    })
  }
}

export interface InboxQueueReplyInput {
  // Raw composer HTML. Empty with a draftId sends the draft as stored.
  rawBody: string
  draftId?: string
  // Which From address a send goes out on. 'personal' uses the sender's alias
  // (with a hard fallback to 'contact' when they have none); default 'contact'.
  fromIdentity?: 'personal' | 'contact'
}

// The `activity` suffix and extra fields land on the reply-queued timeline
// event (the MCP tool uses them to mark sends made by an AI client).
export async function inboxQueueReply(
  tx: Tx,
  conversation: InboxConversationRow,
  senderUserId: string,
  input: InboxQueueReplyInput,
  activity: { suffix?: string, extra?: Record<string, unknown> } = {}
): Promise<InboxMessageRow> {
  await inboxAssertReplyDeliverable(tx, conversation)

  const { rawBody, draftId } = input
  const html = inboxSanitizeEmailHtml(rawBody)
  const text = inboxHtmlToText(html)
  const replySubject = conversation.subject ? `Re: ${conversation.subject.replace(/^Re:\s*/i, '')}` : null

  let message: InboxMessageRow
  if (draftId) {
    const draft = await inboxGetMessage(tx, draftId)
    if (!draft || draft.conversation_id !== conversation.id || draft.status !== 'draft') {
      throw createError({ statusCode: 404, statusMessage: 'Draft not found' })
    }
    // Empty request body keeps the draft's stored body (send-as-is).
    const promoted = await inboxPromoteDraft(tx, {
      id: draftId,
      conversationId: conversation.id,
      bodyHtml: rawBody ? html : (draft.body_html ?? ''),
      bodyText: rawBody ? text : (draft.body_text ?? ''),
      senderUserId
    })
    if (!promoted) throw createError({ statusCode: 404, statusMessage: 'Draft not found' })
    message = promoted
  } else {
    if (!rawBody.trim()) {
      throw createError({ statusCode: 400, statusMessage: 'Body is required' })
    }
    message = await inboxCreateMessage(tx, {
      conversationId: conversation.id,
      direction: 'outbound',
      status: 'queued',
      senderUserId,
      subject: replySubject,
      bodyHtml: html,
      bodyText: text
    })
  }

  // From identity: snapshot the personal From onto the row at queue time
  // (an admin removing the alias later can't change an already-queued send),
  // and bake the signature into body_html only. Personal with no alias falls
  // back to the contact address (from_email cleared → resolved at send) —
  // clearing matters for promoted drafts, which may carry a previous
  // author's alias snapshot the sender has no claim to.
  if (input.fromIdentity === 'personal') {
    const settings = await getInboxSettings(tx)
    const { personalFrom, signature } = await inboxResolvePersonalIdentity(tx, senderUserId, settings)
    if (personalFrom) {
      const sig = signature ? `<br><br>${inboxSanitizeEmailHtml(signature)}` : ''
      await tx
        .updateTable('inbox_messages')
        .set({ from_email: personalFrom, body_html: sql`COALESCE(body_html, '') || ${sig}`, updated_at: new Date() })
        .where('id', '=', message.id)
        .execute()
    } else {
      await tx
        .updateTable('inbox_messages')
        .set({ from_email: null, updated_at: new Date() })
        .where('id', '=', message.id)
        .execute()
    }
  } else if (input.fromIdentity === 'contact') {
    // An explicit shared-address choice must override a personal From that
    // was saved onto the draft — otherwise the send rides the stale alias.
    await tx
      .updateTable('inbox_messages')
      .set({ from_email: null, updated_at: new Date() })
      .where('id', '=', message.id)
      .execute()
  }

  await inboxAssignIfUnassigned(tx, conversation.id, senderUserId)
  await inboxUpdateConversationStatus(tx, conversation.id, 'pending')
  await inboxSetNeedsReview(tx, conversation.id, false)
  // A promoted draft carries its original created_at (possibly stale), so
  // stamp the conversation's last activity with the actual send moment.
  await inboxTouchLastMessage(tx, conversation.id, draftId ? new Date() : message.created_at, 'outbound')
  await inboxLogConversationEvent(tx, conversation.id, 'inbox_reply_queued', `Reply queued${activity.suffix ?? ''}`, {
    userId: senderUserId,
    extra: { messageId: message.id, direction: 'outbound', ...activity.extra }
  })

  return message
}
