// Public intake: turn a submission from outside the mail flow (the contact
// form, a help-chat handoff) into an inbox conversation whose first message is
// the visitor's. Split in two so a consumer can persist its own rows in the SAME
// transaction as the conversation, then run the side effects after commit:
//
//   inboxRecordIntake(tx, …)      — inside the caller's scope tx: channel claim,
//                                   optional consent, conversation, first message.
//   inboxAfterIntake(scope, …)    — post-commit, best-effort: staff notification
//                                   (own tx) and the auto-ack.
//
// A submission is never lost to a notification/courtesy failure — both are
// swallowed and logged. Kernel-style: never imports `db` (inboxWithScopeTx does).
import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import { claimChannel, grantConsent, issueChannelVerificationToken } from '#crm/server'

type Tx = Transaction<Database>

export interface InboxIntakeInput {
  email: string
  name?: string | null
  subject?: string | null
  // Plain-text body; also the source of the HTML body when `bodyHtml` is unset.
  message: string
  // Pre-rendered HTML body (sanitized here regardless).
  bodyHtml?: string | null
  // How the conversation entered the inbox, e.g. 'contact_form', 'helpinator'.
  source: string
  // Only `true` records a marketing opt-in — consent is never inferred.
  consent?: boolean
  // Normalized ISO alpha-2 (see inboxNormalizeCountry), or null.
  country?: string | null
  ip?: string | null
  userAgent?: string | null
  assignedUserId?: string | null
  // Label for the origin event ('Inbound email (contact)').
  originLabel?: string
}

export interface InboxIntakeResult {
  conversationId: string
  replyToken: string
  subject: string
  email: string
  name: string | null
  excerpt: string
  assignedUserId: string | null
  contactAddress: string
  brandFromName: string
  autoAck: boolean
  verificationToken: string | null
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function inboxPlainTextToHtml(text: string): string {
  return `<p>${text.split('\n').map(escapeHtml).join('<br>')}</p>`
}

export async function inboxRecordIntake(tx: Tx, input: InboxIntakeInput): Promise<InboxIntakeResult> {
  const { email, message, source } = input
  const name = input.name ?? null
  const firstLine = message.split('\n').map(l => l.trim()).find(Boolean) ?? ''
  // The 120-char display cap applies to a caller-supplied subject too.
  const subject = (input.subject?.trim() || firstLine || 'Contact form message').slice(0, 120)
  const html = inboxSanitizeEmailHtml(input.bodyHtml ?? inboxPlainTextToHtml(message))
  const country = input.country ?? null

  const channel = await claimChannel(tx, { channelType: 'email', value: email })
  // Explicit consent checkbox → a marketing opt-in on the channel, through the
  // CRM consent kernel (compliance log with the submission's origin as evidence;
  // no session, so the actor is null).
  if (input.consent === true) {
    await grantConsent(tx, { userId: null }, {
      channelId: channel.id,
      purpose: 'marketing',
      source,
      captureMeta: country ? { country } : {},
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null
    })
  }
  // Reissued on every unverified submission so the freshest ack always carries
  // a live link; the token is redeemed at /api/inbox/verify/:token.
  const verificationToken = channel.verified ? null : await issueChannelVerificationToken(tx, channel.id)
  const conversation = await inboxCreateConversation(tx, {
    channelId: channel.id,
    subject,
    status: 'open',
    source,
    assignedUserId: input.assignedUserId ?? null,
    counterpartyName: name
  })
  // Log the origin BEFORE the first message insert, so a failed message write
  // still leaves an explainable shell. The visitor is the SENDER of this
  // conversation's first message, labelled accordingly.
  await inboxLogConversationEvent(tx, conversation.id, 'inbox_conversation_created', 'Conversation opened', {
    extra: { source, sender: email, ...(country ? { country } : {}) }
  })
  const msg = await inboxCreateMessage(tx, {
    conversationId: conversation.id,
    direction: 'inbound',
    status: 'received',
    fromEmail: email,
    fromName: name,
    subject,
    bodyHtml: html,
    bodyText: message
  })
  await inboxTouchLastMessage(tx, conversation.id, msg.created_at, 'inbound', { counterpartyName: name })
  await inboxLogConversationEvent(tx, conversation.id, 'inbox_inbound_received', input.originLabel ?? 'Inbound email (contact)', {
    extra: { outcome: 'contact', source }
  })

  const settings = await getInboxSettings(tx)
  return {
    conversationId: conversation.id,
    replyToken: conversation.reply_token,
    subject,
    email,
    name,
    excerpt: message,
    assignedUserId: input.assignedUserId ?? null,
    contactAddress: settings.contactAddress,
    brandFromName: settings.brandFromName,
    autoAck: settings.autoAckEnabled,
    verificationToken
  }
}

export interface InboxAfterIntakeOptions {
  // Notify staff of the new conversation (default true).
  notify?: boolean
  // Send the auto-ack when the org has it enabled (default true).
  ack?: boolean
  // Extra HTML appended to the auto-ack (e.g. a chat transcript). Trusted —
  // callers escape their own content.
  extraAckHtml?: string | null
  // Test seam hook: throw inside the notify tx.
  beforeNotify?: () => void
}

export async function inboxAfterIntake(
  scope: string | null,
  created: InboxIntakeResult,
  opts: InboxAfterIntakeOptions = {}
): Promise<void> {
  // Staff notification in its OWN transaction: a notify failure inside the
  // persistence tx would abort it, turning COMMIT into a silent ROLLBACK and
  // losing the submission while the visitor still sees success.
  if (opts.notify !== false) {
    await inboxWithScopeTx(scope, async (tx) => {
      opts.beforeNotify?.()
      await inboxNotifyNewMessage(tx, {
        orgId: scope,
        conversationId: created.conversationId,
        assignedUserId: created.assignedUserId,
        counterparty: created.name || created.email,
        subject: created.subject,
        held: false,
        excerpt: created.excerpt,
        senderAddress: created.email
      })
    }).catch(err => console.warn('[inbox] intake notify failed:', err))
  }

  // Auto-ack (fire-and-forget — never blocks or fails the caller).
  if (opts.ack !== false && created.autoAck && created.contactAddress) {
    void inboxSendCourtesy('auto_ack', {
      toEmail: created.email,
      toName: created.name,
      subject: created.subject,
      replyToken: created.replyToken,
      contactAddress: created.contactAddress,
      brandName: created.brandFromName,
      verificationUrl: created.verificationToken ? inboxBuildVerificationUrl(created.verificationToken) : null,
      extraHtml: opts.extraAckHtml ?? null
    }).catch(err => console.warn('[inbox] intake auto-ack failed:', err))
  }
}
