// The outbound send sweep body. A queued inbox_messages row is the send job;
// per org scope the sweep claims each due row (atomic queued→sent) inside a
// short transaction, builds and sends the email OUTSIDE any transaction
// (provider latency must not hold a DB connection), then records the result.
// A confirmed provider failure releases the claim with backoff; a crash
// mid-send leaves the row 'sent' without a provider id — at-most-once, the
// same bias the inbound pipeline has.
//
// Sends go through the mail kernel's `inbox` stream, which picks the sending
// domain, checks its suppression list and guards, and stamps the Message-Id.
//
// Missing configuration is not a failure and never consumes the retry budget:
// an org with no domain that can receive mail has its due mail held (still
// 'queued', same attempts, hold_reason set) and goes out untouched on the
// first sweep after a domain qualifies.
import type { Transaction } from 'kysely'
import type { MailAttachment, SendResult } from '@nuxtinator/mail/kernel'
import type { Database } from '#core/server/database/schema'
import { isSuppressed } from '#crm/server'
import { generateSignedUrl } from '#core/server/utils/storage'
import { sendMail } from '#core/server/utils/mail'
import type { InboxMessageRow } from './inbox-messages'
import type { InboxQuoteCandidate } from './inbox-quote'

type Tx = Transaction<Database>

interface OutboundAttachmentRef {
  s3Key: string
  filename: string | null
  contentType: string | null
}

interface PreparedSend {
  claimed: InboxMessageRow
  toEmail: string
  // The From display name and local part; the domain comes from the kernel.
  fromName: string | undefined
  fromLocal: string
  replyTo: string
  subject: string
  // Assembled body + quoted history, BEFORE the send-time HTML passes. The
  // sweep applies those (embed → re-sanitize → constrain → shell wrap)
  // outside the claim transaction, since embedding does network fetches.
  bodyHtml: string
  text: string | undefined
  inReplyTo: string | undefined
  attachmentRefs: OutboundAttachmentRef[]
}

// Fetch a message's stored attachments as email parts, in the between-tx
// window. A fetch failure THROWS so the send fails/retries — the thread must
// never read 'sent' while an attachment silently went missing. Skipped under
// VITEST (no S3).
async function fetchOutboundAttachments(refs: OutboundAttachmentRef[]): Promise<MailAttachment[]> {
  if (!refs.length || process.env.VITEST) return []
  const out: MailAttachment[] = []
  for (const ref of refs) {
    const url = await generateSignedUrl(ref.s3Key, 300)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Attachment fetch failed (${res.status})`)
    out.push({
      filename: ref.filename || 'attachment',
      contentType: ref.contentType || 'application/octet-stream',
      data: Buffer.from(await res.arrayBuffer())
    })
  }
  return out
}

// Embed composer inline images as CID parts at send time: scan the assembled
// HTML for inline-image proxy URLs, dedupe keys, fetch each from S3, and
// rewrite every occurrence to cid:<basename> (cid === filename, which every
// provider accepts). An unfetchable image is LEFT AS-IS and the send proceeds — a
// broken <img> degrades, unlike a missing file attachment which fails the send.
async function embedInlineImages(html: string): Promise<{ html: string, attachments: MailAttachment[] }> {
  if (process.env.VITEST) return { html, attachments: [] }
  const scan = /\/api\/inbox\/inline-image\/(inbox-inline\/[A-Za-z0-9/_.-]+?\.(?:jpe?g|png|gif|webp))/gi
  const keys = new Set<string>()
  let match: RegExpExecArray | null
  while ((match = scan.exec(html))) keys.add(match[1]!)
  if (!keys.size) return { html, attachments: [] }

  const attachments: MailAttachment[] = []
  let out = html
  for (const key of keys) {
    try {
      const url = await generateSignedUrl(key, 300)
      const res = await fetch(url)
      if (!res.ok) continue
      const basename = key.split('/').pop()!
      attachments.push({
        filename: basename,
        contentType: inboxInlineMimeForKey(key) ?? 'application/octet-stream',
        data: Buffer.from(await res.arrayBuffer()),
        cid: basename
      })
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      out = out.replace(new RegExp(`(?:https?://[^"'\\s)]+)?/api/inbox/inline-image/${escaped}`, 'g'), `cid:${basename}`)
    } catch {
      // leave the URL in place; the send still goes out
    }
  }
  return { html: out, attachments }
}

async function prepareSend(tx: Tx, msg: InboxMessageRow): Promise<PreparedSend | null> {
  const conversation = await inboxGetConversation(tx, msg.conversation_id)
  if (!conversation) {
    await inboxMarkMessageFailed(tx, msg.id, 'Conversation missing')
    return null
  }
  // The same resolver the detail endpoint shows as the reply recipient, so
  // what staff see in the composer is exactly where the mail goes.
  const target = await inboxResolveReplyTarget(tx, conversation, msg.to_email)
  const toEmail = target.email
  if (!toEmail) {
    await inboxMarkMessageFailed(tx, msg.id, 'No recipient')
    return null
  }
  // Deliverability gate only — deliberately NOT canSend(): consent must not
  // block 1:1 conversational replies; a bounce stops sends, a marketing
  // unsubscribe doesn't.
  if (target.channelId && await isSuppressed(tx, target.channelId)) {
    await inboxMarkMessageFailed(tx, msg.id, 'Recipient suppressed')
    return null
  }

  // Configuration gate, deliberately ahead of the claim: without a domain
  // that can receive mail nothing can send, and that stays true until an
  // operator sets one up. Holding costs no attempt, where claiming and
  // releasing would burn the retry budget and land the message in 'failed' —
  // unrecoverable — within minutes. The sweep already holds a whole org's due
  // mail in one pass; this covers a change landing mid-sweep.
  const settings = await getInboxSettings(tx)
  if (!settings.contactAddress) {
    await inboxHoldForConfig(tx, msg.id, INBOX_HOLD_NO_RECEIVING_DOMAIN)
    return null
  }

  const claimed = await inboxClaimForSend(tx, msg.id)
  if (!claimed) return null // another worker won

  const senderName = claimed.sender_user_id
    ? (await tx.selectFrom('users').select('display_name').where('id', '=', claimed.sender_user_id).executeTakeFirst())?.display_name ?? null
    : null

  // Quoted history: everything before this reply, excluding drafts (not in
  // the list) and held messages (never leak a held sender's content, never
  // anchor on it).
  const prior = (await inboxListMessages(tx, conversation.id))
    .filter(m => m.id !== claimed.id && m.status !== 'held')
  const quoteCandidates: InboxQuoteCandidate[] = prior.map(m => ({
    direction: m.direction,
    from_name: m.direction === 'outbound' ? (m.sender_name ?? m.from_name) : m.from_name,
    from_email: m.from_email,
    body_html: m.body_html,
    body_stripped_html: m.body_stripped_html,
    body_text: m.body_text,
    created_at: m.created_at
  }))
  const fallbackName = senderName || 'Team'

  const lastInbound = await inboxGetLastInbound(tx, conversation.id)

  const bodyHtml = (claimed.body_html || '') + inboxBuildQuotedHtml(quoteCandidates, fallbackName)
  const bodyText = (claimed.body_text || '') + inboxBuildQuotedText(quoteCandidates, fallbackName)
  const subject = claimed.subject || (conversation.subject ? `Re: ${conversation.subject.replace(/^Re:\s*/i, '')}` : 'Re:')

  const attachmentRefs: OutboundAttachmentRef[] = (await inboxListAttachmentsForMessage(tx, claimed.id))
    .map(a => ({ s3Key: a.s3_key, filename: a.filename, contentType: a.content_type }))

  // From local part: the personal alias snapshotted onto the row at queue
  // time, else the shared contact address's; the domain is always the one the
  // kernel resolves. A personal send carries the agent's CURRENT display_name
  // (not snapshotted, so a rename shows on pending sends); a shared-address
  // send carries the org's brand From name — the shared identity exists to
  // not expose the individual. Reply-To always stays the contact+<token>
  // address so the contact's reply threads back regardless of which From we
  // sent on.
  const usingPersonalFrom = !!claimed.from_email
  const fromBase = claimed.from_email || settings.contactAddress

  return {
    claimed,
    toEmail,
    fromName: (usingPersonalFrom ? senderName : settings.brandFromName) || undefined,
    fromLocal: fromBase.slice(0, fromBase.lastIndexOf('@')),
    replyTo: inboxBuildReplyAddress(conversation.reply_token, settings.contactAddress),
    subject,
    bodyHtml,
    text: bodyText || undefined,
    inReplyTo: lastInbound?.email_message_id ?? undefined,
    attachmentRefs
  }
}

export async function inboxRunSendSweep(): Promise<void> {
  for (const orgId of await inboxListOrgScopes()) {
    const due = await inboxWithScopeTx(orgId, tx => inboxListDueQueued(tx))
    if (due.length === 0) continue

    // One settings read per org per sweep. An org with no receiving domain
    // can't send anything, so its whole due batch is held together and
    // reported once — not once per message, and not once for the whole sweep,
    // which would hide which org needs attention.
    const orgSettings = await inboxWithScopeTx(orgId, tx => getInboxSettings(tx))
    if (!orgSettings.contactAddress) {
      await inboxWithScopeTx(orgId, async (tx) => {
        for (const msg of due) await inboxHoldForConfig(tx, msg.id, INBOX_HOLD_NO_RECEIVING_DOMAIN)
      })
      console.warn(
        `[inbox] ${due.length} queued message(s) held for org ${orgId ?? 'single-tenant'} — `
        + 'no domain can receive mail yet; set one up under Admin → Email to release them'
      )
      continue
    }

    for (const msg of due) {
      let prep: PreparedSend | null = null
      try {
        prep = await inboxWithScopeTx(orgId, tx => prepareSend(tx, msg))
      } catch (err) {
        console.error('[inbox] send prepare failed:', err instanceof Error ? err.message : err)
        continue
      }
      if (!prep) continue

      // Attachments are fetched OUTSIDE the claim tx (provider latency must not
      // hold a connection). A fetch failure releases the claim for retry — the
      // message never reads 'sent' with a missing attachment.
      let attachments: MailAttachment[]
      try {
        attachments = await fetchOutboundAttachments(prep.attachmentRefs)
      } catch (err) {
        await inboxWithScopeTx(orgId, tx => inboxReleaseForRetry(tx, prep!.claimed, err instanceof Error ? err.message : 'Attachment fetch failed'))
        continue
      }

      // Send-time HTML passes, in order: inline images become CID parts and
      // rewrite the HTML (unfetchable ones degrade rather than fail the send);
      // the assembled body is re-sanitized at this sink (belt-and-braces — the
      // pieces were sanitized at write time, but the sink must not trust
      // assembly); every <img> gets the size cap; the shell wraps last so its
      // head/body chrome isn't subject to the body sanitizer.
      const embedded = await embedInlineImages(prep.bodyHtml)
      const allAttachments = [...attachments, ...embedded.attachments]
      const html = inboxRenderMessageEmail({
        bodyHtml: inboxConstrainImages(inboxSanitizeEmailHtml(embedded.html)),
        subject: prep.subject
      })

      let result: SendResult
      try {
        result = await sendMail({
          stream: 'inbox',
          orgId,
          fromName: prep.fromName,
          fromLocal: prep.fromLocal,
          to: prep.toEmail,
          replyTo: prep.replyTo,
          subject: prep.subject,
          html,
          text: prep.text,
          inReplyTo: prep.inReplyTo,
          references: prep.inReplyTo,
          attachments: allAttachments.length ? allAttachments : undefined,
          ref: prep.claimed.id
        })
      } catch (err) {
        result = { status: 'failed', retryable: true, error: err instanceof Error ? err.message : 'Send failed' }
      }

      await inboxWithScopeTx(orgId, tx => inboxRecordSendResult(tx, prep!.claimed, result))
    }
  }
}

// Records the kernel's answer for a claimed message. 'unknown' (the provider
// may or may not have taken it) stays 'sent' without an id: at-most-once.
async function inboxRecordSendResult(tx: Tx, claimed: InboxMessageRow, result: SendResult): Promise<void> {
  switch (result.status) {
    case 'sent':
      await inboxMarkSent(tx, claimed.id, result.messageId, result.providerMessageId)
      return
    case 'unknown':
    case 'queued':
      await inboxMarkSent(tx, claimed.id, null)
      return
    case 'suppressed':
      await inboxMarkMessageFailed(tx, claimed.id, 'Recipient suppressed')
      return
    case 'refused':
      await inboxMarkMessageFailed(tx, claimed.id, result.reason)
      return
    case 'no_sender':
      await inboxReleaseForHold(tx, claimed, INBOX_HOLD_NO_RECEIVING_DOMAIN)
      return
    case 'failed':
      if (result.retryable) await inboxReleaseForRetry(tx, claimed, result.error || 'Send failed')
      else await inboxMarkMessageFailed(tx, claimed.id, result.error || 'Send failed')
  }
}
