// The inbox's catch-all inbound handler — the receiving half of the inbox.
// The mail kernel verifies the provider webhook, parses the MIME and calls
// this once per receiving recipient on a domain whose receiving account the
// webhook arrived on.
//
// The *sender* is never trusted from the From header alone — DKIM/DMARC
// alignment gates side effects (verification, courtesy replies) and
// channel-matching gates threading.
//
// Org routing (no session, no X-Active-Org):
//   1. Reply-token mail — the token names exactly one conversation globally,
//      so `withRecordOrgContext` resolves its org in O(1).
//   2. Anything else — `inboxResolveOrgForInbound`: the org owning the
//      receiving domain, else (on a host domain) the org slug under slug
//      addresses or the single-mode inbox. Unroutable mail is dropped, because
//      a retry would make the provider redeliver forever.
//
// Durability choreography (at-most-once, never duplicated):
//   tx A     resolve + claim: dedupe by Message-Id, thread, insert the
//            message row (bare ON CONFLICT dedupe claim). Committed before
//            any slow I/O.
//   phase B  artifacts: attachments + raw MIME to S3, outside any
//            transaction. On failure the claim row is DELETED and 'retry'
//            returned — the provider's redelivery re-inserts and re-runs
//            persistence (the committed conversation shell is reused, so
//            retries converge on one conversation).
//   tx C     side effects: attachment rows, status transitions, denorms,
//            channel verification, staff notifications.
//   after    fire-and-forget courtesy mail (auto-ack / held notice) with
//            anti-backscatter gates.
// A crash between B and C loses side effects for that message but never
// duplicates it — the retry hits the dedupe and reports duplicate.
import { createHash } from 'node:crypto'
import { sql } from 'kysely'
import type { H3Event } from 'h3'
import type { InboundContext, InboundMail, InboundOutcome } from '@nuxtinator/mail/kernel'
import { withRecordOrgContext } from '#tenant/server'
import { uploadToS3 } from '#core/server/utils/storage'
import { claimChannel, findChannel, markChannelVerified } from '#crm/server'
import type { InboxConversationRow } from './inbox-conversations'

// Transient failures bubble up as this so the catch can ask for a retry.
class TransientError extends Error {}

interface StoredOutcome {
  kind: 'stored'
  conversation: InboxConversationRow
  messageId: string
  outcome: 'contact' | 'held'
  isNewConversation: boolean
  looksAutoReply: boolean
  isVacationReply: boolean
  authenticated: boolean
}

type TxAOutcome =
  | StoredOutcome
  | { kind: 'duplicate', conversationId?: string }
  | { kind: 'spam', conversationId: string }

export async function inboxHandleInbound(mail: InboundMail, ctx: InboundContext): Promise<InboundOutcome> {
  const recipient = ctx.recipient.address
  const headers = mail.headers
  const fromHeader = headers.get('from') || ''
  const fromEmail = mail.from?.address ?? inboxExtractEmailAddress(fromHeader)
  const fromName = mail.from?.name || inboxExtractDisplayName(fromHeader)
  const subject = mail.subject || ''
  const bodyHtml = mail.html || ''
  const bodyStrippedHtml = inboxStripQuotedHtml(bodyHtml)
  const bodyText = inboxStripQuotedText(mail.text) || inboxHtmlToText(bodyStrippedHtml || bodyHtml).trim()

  if (!fromEmail) {
    console.warn(`[inbox] dropped inbound mail to "${recipient}" with no sender address`)
    return 'drop'
  }

  const messageId = headers.get('message-id') || mail.messageId || null
  const inReplyTo = headers.get('in-reply-to') || null
  const references = headers.get('references') || null
  const auth = inboxParseAuthentication(headers, fromEmail)
  const spamScore = mail.spamScore ?? null

  const parsedRecipient = inboxParseRecipient(recipient)
  if (!parsedRecipient) return 'drop'

  // Mail to the VERP bounce/return-path is machine-to-machine, not human
  // inbox mail — RFC 3834 responders reply to the Return-Path and land here.
  // Real bounces arrive as delivery events, not inbound mail.
  if (inboxIsBounceRecipient(parsedRecipient)) return 'drop'

  // --- Resolve the org scope ---
  let scope: string | null | undefined
  if (parsedRecipient.token) {
    try {
      // withRecordOrgContext never reads the event; there is none here.
      scope = await withRecordOrgContext(
        undefined as unknown as H3Event,
        {
          table: 'inbox_conversations',
          idColumn: 'reply_token',
          id: parsedRecipient.token,
          validateUuid: false,
          notFoundMessage: 'Unknown reply token'
        },
        async (tx) => {
          const res = await sql<{ org: string | null }>`
            select nullif(current_setting('app.current_org', true), '') as org
          `.execute(tx)
          return res.rows[0]?.org ?? null
        }
      )
    } catch {
      // Stale/forged token — fall through to domain routing so the mail can
      // still land as a fresh conversation in the domain's org.
      scope = undefined
    }
  }
  if (scope === undefined) {
    scope = await inboxResolveOrgForInbound(parsedRecipient, ctx.domain)
  }
  if (scope === undefined) {
    console.warn(`[inbox] unroutable inbound recipient "${recipient}" — no org claims it`)
    return 'drop'
  }

  // --- Idempotency key ---
  // Prefer the real Message-Id; synthesize a stable key from the envelope
  // when the mail has none, so a redelivery of a header-less message dedupes
  // instead of duplicating (a NULL email_message_id never conflicts).
  const dedupeKey = messageId || synthesizeMessageId({
    from: fromEmail,
    recipient,
    subject,
    date: headers.get('date') || '',
    body: bodyText || bodyHtml || ''
  })

  try {
    // --- tx A: resolve + claim ---
    const a = await inboxWithScopeTx(scope, async (tx): Promise<TxAOutcome> => {
      const existing = await inboxFindMessageByEmailMessageId(tx, dedupeKey)
      if (existing) {
        return { kind: 'duplicate', conversationId: existing.conversation_id }
      }

      const senderChannel = await findChannel(tx, { channelType: 'email', value: fromEmail })

      // Blocklisted sender: attach to their existing spam thread (or open
      // one), auto-close their threads, no notifications, stop.
      if (senderChannel && await inboxIsChannelBlocked(tx, senderChannel.id)) {
        const latest = await inboxGetLatestForChannel(tx, senderChannel.id)
        const convo = latest && latest.status === 'spam'
          ? latest
          : await inboxCreateConversation(tx, {
              channelId: senderChannel.id,
              subject: subject || null,
              status: 'spam',
              source: 'inbound_email',
              counterpartyName: fromName
            })
        const spamMsg = await inboxCreateMessageIfNew(tx, {
          conversationId: convo.id,
          direction: 'inbound',
          status: 'received',
          fromEmail,
          fromName,
          toEmail: recipient,
          subject,
          bodyHtml,
          bodyStrippedHtml,
          bodyText,
          emailMessageId: dedupeKey,
          inReplyTo,
          emailReferences: references,
          spamScore,
          authenticated: auth.authenticated,
          authResult: auth.authResult
        })
        if (!spamMsg) return { kind: 'duplicate', conversationId: convo.id }
        await inboxCloseForChannelAsSpam(tx, senderChannel.id)
        await inboxTouchLastMessage(tx, convo.id, spamMsg.created_at, 'inbound')
        return { kind: 'spam', conversationId: convo.id }
      }

      // Conversation resolution, in trust order.
      let conversation: InboxConversationRow | null = null
      if (parsedRecipient.token) {
        conversation = await inboxFindByReplyToken(tx, parsedRecipient.token)
      }
      if (!conversation && (inReplyTo || references)) {
        // In-Reply-To/References are attacker-controlled: only thread into an
        // existing conversation when the sender's channel IS that
        // conversation's channel. Anything else falls through to a fresh
        // conversation (or lands held below when a token matched).
        const ids = [inReplyTo, ...(references ? references.split(/\s+/) : [])].filter(Boolean) as string[]
        const convoId = await inboxFindConversationByMessageIds(tx, ids)
        if (convoId && senderChannel) {
          const candidate = await inboxGetConversation(tx, convoId)
          if (candidate && candidate.channel_id === senderChannel.id) {
            conversation = candidate
          }
        }
      }

      const isNewConversation = !conversation
      if (!conversation) {
        const channel = senderChannel ?? await claimChannel(tx, { channelType: 'email', value: fromEmail })
        // Reuse a recent message-less shell for this sender: it only exists
        // because a prior inbound failed after the conversation committed, so
        // provider retries converge on one conversation.
        const reused = await inboxGetRecentEmptyForChannel(tx, channel.id)
        if (reused) {
          conversation = reused
        } else {
          // Alias routing: tokenless mail to <alias>@domain (a local part that
          // is neither the shared contact address nor the bounce VERP)
          // auto-assigns the fresh conversation to that alias's owner — turning
          // the staff alert from a broadcast into an assignee-immediate one.
          // reply-token beats alias beats References, so this only runs when no
          // token matched. It applies to fresh conversations only, never the
          // reused empty shell above.
          let assignedUserId: string | null = null
          if (!parsedRecipient.token && !inboxIsBounceRecipient(parsedRecipient)) {
            const settings = await getInboxSettings(tx)
            const contactBase = inboxParseRecipient(settings.contactAddress)?.base ?? settings.contactLocal
            if (parsedRecipient.base !== contactBase) {
              assignedUserId = await inboxResolveAliasUser(tx, parsedRecipient.base)
            }
          }
          conversation = await inboxCreateConversation(tx, {
            channelId: channel.id,
            subject: subject || null,
            source: 'inbound_email',
            counterpartyName: fromName,
            assignedUserId
          })
          // Origin row commits WITH the shell (log-before-store): if phase B
          // then fails for good, the leftover empty conversation still
          // explains itself. The reused-shell branch above was logged by its
          // own first ingest.
          await inboxLogConversationEvent(tx, conversation.id, 'inbox_conversation_created', 'Conversation opened', {
            extra: { source: 'inbound_email', recipient, sender: fromEmail }
          })
        }
      }

      // Classification: mail that reached an existing conversation with a
      // From that doesn't own it is held for human review — never trusted,
      // never a reply anchor.
      const senderIsCounterparty = isNewConversation
        || (senderChannel !== null && senderChannel.id === conversation.channel_id)
      const outcome: 'contact' | 'held' = senderIsCounterparty ? 'contact' : 'held'

      const looksAutoReply = inboxIsAutoResponderOrBounce(headers, fromEmail)
      const isVacationReply = inboxIsVacationAutoReply(headers, fromEmail)

      const stored = await inboxCreateMessageIfNew(tx, {
        conversationId: conversation.id,
        direction: 'inbound',
        status: outcome === 'held' ? 'held' : 'received',
        fromEmail,
        fromName,
        toEmail: recipient,
        subject,
        bodyHtml,
        bodyStrippedHtml,
        bodyText,
        emailMessageId: dedupeKey,
        inReplyTo,
        emailReferences: references,
        spamScore,
        authenticated: auth.authenticated,
        authResult: auth.authResult,
        holdReason: outcome === 'held' ? 'Sender does not match this conversation' : null
      })
      if (!stored) return { kind: 'duplicate', conversationId: conversation.id }

      return {
        kind: 'stored',
        conversation,
        messageId: stored.id,
        outcome,
        isNewConversation,
        looksAutoReply,
        isVacationReply,
        authenticated: auth.authenticated
      }
    })

    if (a.kind === 'duplicate' || a.kind === 'spam') return 'handled'

    // --- phase B: artifacts (outside any transaction) ---
    // A storage failure deletes the claim row and asks for a retry so the
    // redelivery re-inserts and re-runs persistence — a half-stored message
    // is never acknowledged.
    let attachmentUploads: { s3Key: string, filename: string, contentType: string | null, sizeBytes: number }[] = []
    let rawKey: string | null = null
    // Test seam (VITEST only): simulate an artifact-persistence failure so the
    // suite can pin the delete-claim + retry contract without an S3 outage.
    if (process.env.VITEST && headers.get('x-test-fail') === 'persist') {
      await inboxWithScopeTx(scope, tx => inboxDeleteMessage(tx, a.messageId))
      throw new TransientError('Injected persistence failure')
    }
    if (process.env.S3_ENDPOINT) {
      try {
        attachmentUploads = await persistAttachmentFiles(mail)
        const upload = await uploadToS3(mail.raw, `raw-${a.messageId}.eml`, 'message/rfc822', 'private', 'inbox')
        rawKey = upload.key
      } catch (s3err) {
        await inboxWithScopeTx(scope, tx => inboxDeleteMessage(tx, a.messageId))
        throw new TransientError(s3err instanceof Error ? s3err.message : 'Attachment persistence failed')
      }
    } else if (mail.attachments.length > 0) {
      // Deliberate SLA choice: an S3-less deploy still accepts mail (retrying
      // would eventually make the provider drop it entirely), but dropping
      // real attachments is data loss — shout at error level.
      console.error(`[inbox] S3 not configured — DROPPING ${mail.attachments.length} inbound attachment(s) and the raw MIME for message ${a.messageId}`)
    } else {
      console.warn('[inbox] S3 not configured — inbound raw MIME is not archived')
    }

    // --- tx C: side effects ---
    const courtesy = await inboxWithScopeTx(scope, async (tx) => {
      for (const up of attachmentUploads) {
        await inboxAddAttachment(tx, {
          messageId: a.messageId,
          s3Key: up.s3Key,
          filename: up.filename,
          contentType: up.contentType,
          sizeBytes: up.sizeBytes
        })
      }
      if (rawKey) {
        await tx
          .updateTable('inbox_messages')
          .set({ raw_s3_key: rawKey, updated_at: new Date() })
          .where('id', '=', a.messageId)
          .execute()
      }

      const message = await inboxGetMessage(tx, a.messageId)
      const messageAt = message?.created_at ?? new Date()

      if (a.outcome === 'contact') {
        // Contact replied → the ball is back with the team: pending/closed
        // reopen. A vacation auto-reply closes instead — it must not surface
        // as needing attention.
        if (a.isVacationReply) {
          await inboxUpdateConversationStatus(tx, a.conversation.id, 'closed')
        } else if (a.conversation.status === 'pending' || a.conversation.status === 'closed') {
          await inboxUpdateConversationStatus(tx, a.conversation.id, 'open')
        }
        await inboxTouchLastMessage(tx, a.conversation.id, messageAt, 'inbound', { counterpartyName: fromName })
        if (subject) await inboxSetSubjectIfEmpty(tx, a.conversation.id, subject)

        // Authenticated inbound proves address ownership — the only signal
        // that ever verifies a channel.
        if (a.authenticated) {
          await markChannelVerified(tx, a.conversation.channel_id)
        }
      } else {
        // held
        if (a.isVacationReply) {
          // A vacation / OOO auto-reply from an unrecognized sender is noise,
          // not an inquiry — close quietly, don't flag or notify. A DSN or
          // list/bulk message still lands held + needs-review + notify so a
          // human sees it (bounces reaching the inbound route are worth
          // surfacing; they normally arrive as delivery events instead).
          await inboxUpdateConversationStatus(tx, a.conversation.id, 'closed')
        } else {
          await inboxSetNeedsReview(tx, a.conversation.id, true)
        }
        await inboxTouchLastMessage(tx, a.conversation.id, messageAt, 'inbound')
      }

      const notify
        = (a.outcome === 'held' && !a.isVacationReply)
          || (a.outcome === 'contact' && !a.isVacationReply)
      if (notify) {
        await inboxNotifyNewMessage(tx, {
          orgId: scope,
          conversationId: a.conversation.id,
          assignedUserId: a.conversation.assigned_user_id,
          counterparty: fromName || fromEmail,
          subject: subject || a.conversation.subject,
          held: a.outcome === 'held',
          isReply: !a.isNewConversation && a.outcome === 'contact',
          excerpt: bodyText || bodyStrippedHtml.replace(/<[^>]*>/g, ' '),
          senderAddress: fromEmail,
          attachmentNames: attachmentUploads.map(u => u.filename)
        })
      }

      // Audit trail (system actor — no session). The conversation-origin row
      // was written in tx A alongside the shell; this logs the per-inbound
      // classification outcome.
      const autoReplyNote = a.isVacationReply ? ', auto-reply → closed' : ''
      await inboxLogConversationEvent(tx, a.conversation.id, 'inbox_inbound_received', `Inbound email (${a.outcome}${autoReplyNote})`, {
        extra: { outcome: a.outcome, authenticated: a.authenticated, autoReply: a.looksAutoReply, vacation: a.isVacationReply }
      })

      return await getInboxSettings(tx)
    })

    // --- post-commit: courtesy mail (fire-and-forget, anti-backscatter) ---
    // Only to authenticated senders (a forged From must not trigger mail to
    // the victim) that aren't themselves auto-responders (no loops).
    const eligible = a.authenticated && !inboxIsAutoResponderOrBounce(headers, fromEmail)
    const courtesyKind = a.outcome === 'held' && !a.looksAutoReply
      ? 'held_sender' as const
      : (a.outcome === 'contact' && a.isNewConversation && !a.isVacationReply && courtesy.autoAckEnabled
          ? 'auto_ack' as const
          : null)
    if (eligible && courtesyKind && courtesy.contactAddress) {
      void inboxSendCourtesy(courtesyKind, {
        orgId: scope,
        toEmail: fromEmail,
        toName: fromName,
        subject: subject || a.conversation.subject,
        replyToken: a.conversation.reply_token,
        contactAddress: courtesy.contactAddress,
        brandName: courtesy.brandFromName
      }).catch(err => console.warn('[inbox] courtesy send failed:', err))
    }

    return 'handled'
  } catch (error) {
    if (error instanceof TransientError) return 'retry'
    // The dedupe race is absorbed by createIfNew's bare ON CONFLICT (returns
    // null, never raises), so anything reaching here is unexpected — retry it
    // rather than report "handled" and silently drop an unpersisted message.
    console.error('[inbox] inbound mail error:', error instanceof Error ? error.message : error)
    return 'retry'
  }
}

// Deterministic stand-in Message-Id for inbound mail that arrives without
// one: the same envelope always synthesizes the same key, so a redelivery
// dedupes instead of re-creating the conversation and re-firing side effects.
function synthesizeMessageId(parts: { from: string, recipient: string, subject: string, date: string, body: string }): string {
  const hash = createHash('sha256')
    .update([parts.from, parts.recipient, parts.subject, parts.date, parts.body].join('\n'))
    .digest('hex')
  return `<synthesized-${hash}@inbound.local>`
}

// Every attachment part, inline ones included, minus blocked types and
// oversized files.
async function persistAttachmentFiles(
  mail: InboundMail
): Promise<{ s3Key: string, filename: string, contentType: string | null, sizeBytes: number }[]> {
  const out: { s3Key: string, filename: string, contentType: string | null, sizeBytes: number }[] = []
  for (const part of mail.attachments) {
    if (INBOX_BLOCKED_EXTENSIONS.test(part.filename)) continue
    if (part.data.length > INBOX_MAX_ATTACHMENT_BYTES) continue
    const upload = await uploadToS3(part.data, part.filename, part.contentType || 'application/octet-stream', 'private', 'inbox')
    out.push({ s3Key: upload.key, filename: part.filename, contentType: part.contentType || null, sizeBytes: part.data.length })
  }
  return out
}
