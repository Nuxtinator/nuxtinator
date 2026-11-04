// GET /api/inbox/conversations/:id
// The full detail-pane payload: conversation, thread messages (attachment
// metadata attached per message, served via the auth proxy), the channel's
// linked contact chips (only for callers with CRM contacts read — the inbox
// must not leak contact names past CRM permissions), capability flags, and
// the deliverability of the address a reply will go to.

import { withOrgPermission } from '#tenant/server'
import { resolveTypePermission } from '#crm/server'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  return await withOrgPermission(event, { appId: 'inbox' }, 'inbox.access', async (tx, ctx) => {
    const conversation = await inboxGetConversation(tx, id)
    if (!conversation) {
      throw createError({ statusCode: 404, statusMessage: 'Conversation not found' })
    }

    const channel = await tx
      .selectFrom('crm_channels')
      .select(['id', 'value', 'verified'])
      .where('id', '=', conversation.channel_id)
      .executeTakeFirst()

    const [messages, drafts, attachments, blocked, replyStatus] = await Promise.all([
      inboxListMessages(tx, conversation.id),
      inboxListDrafts(tx, conversation.id),
      inboxListAttachmentsForConversation(tx, conversation.id),
      inboxIsChannelBlocked(tx, conversation.channel_id),
      inboxGetReplyStatus(tx, conversation)
    ])

    const attachmentsByMessage = new Map<string, { id: string, filename: string | null, contentType: string | null, sizeBytes: number | null }[]>()
    for (const a of attachments) {
      const list = attachmentsByMessage.get(a.message_id) ?? []
      list.push({ id: a.id, filename: a.filename, contentType: a.content_type, sizeBytes: a.size_bytes })
      attachmentsByMessage.set(a.message_id, list)
    }

    // Contact chips: every contact record linking this address, gated on CRM
    // read. resolveTypePermission (not a flat slug check) so per-type role
    // grants are honored.
    let contacts: { id: string, name: string }[] = []
    const canReadContacts = await resolveTypePermission(tx, ctx, 'contacts', 'read')
    if (canReadContacts) {
      contacts = await tx
        .selectFrom('crm_contact_channels')
        .innerJoin('crm_records', 'crm_records.id', 'crm_contact_channels.record_id')
        .select(['crm_records.id', 'crm_records.name'])
        .where('crm_contact_channels.channel_id', '=', conversation.channel_id)
        .where('crm_records.record_type', '=', 'contacts')
        .groupBy(['crm_records.id', 'crm_records.name'])
        .execute()
    }

    const canCreateContact = contacts.length === 0 && canReadContacts
      ? await resolveTypePermission(tx, ctx, 'contacts', 'create')
      : false

    return {
      conversation: {
        id: conversation.id,
        subject: conversation.subject,
        status: conversation.status,
        assignedUserId: conversation.assigned_user_id,
        needsReview: conversation.needs_review,
        source: conversation.source,
        counterpartyName: conversation.counterparty_name,
        tags: conversation.tags,
        lastMessageAt: conversation.last_message_at,
        createdAt: conversation.created_at
      },
      channel: channel
        ? { value: channel.value, verified: channel.verified, blocked }
        : null,
      contacts,
      // Where a reply goes and whether it can be delivered there — resolved by
      // the same util the send sweep uses.
      replyStatus,
      capabilities: {
        canSend: ctx.perms.has('inbox.send'),
        canCreateContact
      },
      messages: messages.map(m => ({
        id: m.id,
        direction: m.direction,
        status: m.status,
        senderName: m.sender_name,
        fromEmail: m.from_email,
        fromName: m.from_name,
        toEmail: m.to_email,
        subject: m.subject,
        bodyHtml: m.body_html,
        bodyStrippedHtml: m.body_stripped_html,
        bodyText: m.body_text,
        authenticated: m.authenticated,
        holdReason: m.hold_reason,
        failedReason: m.failed_reason,
        deliveredAt: m.delivered_at,
        createdAt: m.created_at,
        aiGenerated: m.ai_generated,
        attachments: attachmentsByMessage.get(m.id) ?? []
      })),
      // Shared drafts — every inbox.send user sees and can send/edit/delete any
      // of them. Kept separate from `messages` (they're not part of the thread).
      drafts: drafts.map(d => ({
        id: d.id,
        senderName: d.sender_name,
        fromEmail: d.from_email,
        subject: d.subject,
        bodyHtml: d.body_html,
        bodyText: d.body_text,
        createdAt: d.created_at,
        aiGenerated: d.ai_generated,
        // Reviewer-only AI pack (gloss/sources/uncertainty); re-surfaced in the
        // composer when an AI draft is reopened. Never part of the outbound mail.
        aiMetadata: d.ai_metadata,
        attachments: attachmentsByMessage.get(d.id) ?? []
      }))
    }
  })
})
