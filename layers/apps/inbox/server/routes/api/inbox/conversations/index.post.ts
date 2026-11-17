// POST /api/inbox/conversations
// Body: { toEmail | channelId, subject, body }. Starts a new outbound
// conversation: claims (or reuses) the recipient's channel identity, creates
// the conversation assigned to the sender with source 'staff' and status
// 'pending' (waiting on the contact), and queues the first message for the
// send sweep.

import { z } from 'zod'
import { sql } from 'kysely'
import { withOrgPermission } from '#tenant/server'
import { claimChannel } from '#crm/server'

const Body = z.object({
  toEmail: z.string().email().optional(),
  channelId: z.string().uuid().optional(),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(500_000),
  fromIdentity: z.enum(['personal', 'contact']).optional()
}).refine(b => b.toEmail || b.channelId, { message: 'toEmail or channelId is required' })

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'inbox' }, 'inbox.send', async (tx, ctx) => {
    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }

    let channelId = parsed.data.channelId ?? null
    let toEmail = parsed.data.toEmail ?? null
    if (channelId) {
      const channel = await tx
        .selectFrom('crm_channels')
        .select(['id', 'value', 'channel_type'])
        .where('id', '=', channelId)
        .executeTakeFirst()
      if (!channel || channel.channel_type !== 'email') {
        throw createError({ statusCode: 404, statusMessage: 'Channel not found' })
      }
      toEmail = channel.value
    } else {
      const channel = await claimChannel(tx, { channelType: 'email', value: toEmail! })
      channelId = channel.id
    }

    const html = inboxSanitizeEmailHtml(parsed.data.body)

    const conversation = await inboxCreateConversation(tx, {
      channelId: channelId!,
      subject: parsed.data.subject,
      status: 'pending',
      assignedUserId: ctx.userId,
      source: 'staff'
    })
    // Snapshot the personal From address + bake the signature at queue time
    // (personal only; no alias falls back to the shared contact address).
    let fromEmail: string | null = null
    let bodyHtml = html
    if (parsed.data.fromIdentity === 'personal') {
      const { personalFrom, signature } = await inboxResolvePersonalIdentity(tx, ctx.userId, await getInboxSettings(tx))
      if (personalFrom) {
        fromEmail = personalFrom
        if (signature) bodyHtml = `${html}<br><br>${inboxSanitizeEmailHtml(signature)}`
      }
    }

    const message = await inboxCreateMessage(tx, {
      conversationId: conversation.id,
      direction: 'outbound',
      status: 'queued',
      senderUserId: ctx.userId,
      fromEmail,
      toEmail,
      subject: parsed.data.subject,
      bodyHtml,
      bodyText: inboxHtmlToText(html)
    })
    await inboxTouchLastMessage(tx, conversation.id, message.created_at, 'outbound')
    await inboxLogConversationEvent(tx, conversation.id, 'inbox_conversation_created', 'Conversation created', {
      userId: ctx.userId,
      extra: { source: 'staff', recipient: toEmail }
    })

    return { id: conversation.id, messageId: message.id }
  })
})
