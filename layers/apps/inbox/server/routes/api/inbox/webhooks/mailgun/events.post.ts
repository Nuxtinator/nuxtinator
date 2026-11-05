// Mailgun delivery-event webhook. Three independent jobs:
//   1. Address suppression — hard bounces / complaints write a
//      crm_channel_suppressions row so every send path (this layer's and any
//      future sender layer's) stops mailing the address.
//   2. Marketing unsubscribe — a consent signal, not a dead mailbox: flips
//      the channel's 'marketing' consent to opt-out. Deliverability
//      (conversational/transactional mail) is untouched.
//   3. Outbound message state — flips the matching inbox message to
//      delivered/failed by provider message-id. Only delivery outcomes
//      (delivered/failed/permanent_fail/rejected) flip state; complaints and
//      legacy bounces correlate read-only (job 1 is their whole effect), and
//      a failure never downgrades an already-delivered message.
// Never touches channel `verified` — ownership is established solely by
// authenticated inbound mail.
//
// Org routing: sends attach a `v:inbox-org` user-variable that Mailgun echoes
// back in every event; when absent (or the event predates it) the scopes are
// scanned for a message matching the provider id. Events that can't be
// correlated at all are acknowledged and logged — retrying can't make an
// unknown message known.
import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { TenantContext } from '#tenant/server'
import { recordRecordsActivity } from '#records/server'
import { claimChannel, findChannel, recordDeliverySuppression, revokeConsent } from '#crm/server'

// Map a Mailgun event to a deliverability-suppression reason, or null when it
// must not suppress. A `failed` event suppresses only on an explicit
// permanent severity — a missing/unknown severity is treated as transient
// (don't permanently kill an address on an ambiguous event). Legacy
// permanent_fail/rejected/bounced are always permanent. `unsubscribed` is NOT
// here — it's a marketing consent opt-out, not a suppression.
function classifySuppression(eventType: string, severity: string): 'hard_bounce' | 'complaint' | null {
  if (eventType === 'complained') return 'complaint'
  if (eventType === 'failed') return severity === 'permanent' ? 'hard_bounce' : null
  if (eventType === 'permanent_fail' || eventType === 'rejected' || eventType === 'bounced') return 'hard_bounce'
  return null
}

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()

  const body = await readBody<Record<string, unknown>>(event).catch(() => null)
  if (!body) {
    throw createError({ statusCode: 400, statusMessage: 'Malformed payload' })
  }

  // Event webhooks nest the signature; tolerate both shapes.
  const rawSig = body.signature as Record<string, string> | undefined
  const sig = rawSig && typeof rawSig === 'object'
    ? rawSig
    : { timestamp: String(body.timestamp || ''), token: String(body.token || ''), signature: String(body.signature || '') }
  const check = inboxValidateMailgunWebhook(
    { timestamp: sig.timestamp || '', token: sig.token || '', signature: sig.signature || '' },
    String(config.mailgunWebhookSigningKey || '')
  )
  if (!check.ok) {
    throw createError({ statusCode: 406, statusMessage: check.reason || 'Invalid signature' })
  }

  const eventData = (body['event-data'] || body) as Record<string, unknown>
  const eventType = String(eventData.event || '').toLowerCase()
  const severity = String(eventData.severity || '').toLowerCase()
  const recipient = String(eventData.recipient || '')
  const deliveryStatus = eventData['delivery-status'] as Record<string, unknown> | undefined
  const reasonText = String(deliveryStatus?.message || eventData.reason || eventData.severity || '')
  const message = eventData.message as { headers?: Record<string, string> } | undefined
  const messageId = String(
    message?.headers?.['message-id'] || eventData['message-id'] || body['Message-Id'] || ''
  )
  const userVars = eventData['user-variables'] as Record<string, string> | undefined
  const orgVar = userVars?.['inbox-org'] || ''

  try {
    // Resolve which scopes to process. `v:inbox-org` names the org exactly;
    // otherwise every scope is tried and the ones that can act, act (the
    // suppression insert is idempotent; correlation matches at most one).
    const scopes: (string | null)[] = orgVar
      ? [orgVar]
      : await inboxListOrgScopes()

    let suppressed = false
    let unsubscribed = false
    let matched = false

    const suppressReason = recipient ? classifySuppression(eventType, severity) : null

    for (const scope of scopes) {
      const acted = await inboxWithScopeTx(scope, async (tx) => {
        let scopeActed = false

        // 2. Outbound message correlation — also anchors org resolution for
        // events without the user-variable. Only true delivery outcomes
        // (delivered/failed/permanent_fail/rejected) write message state;
        // complaints and legacy bounces correlate read-only — the mail WAS
        // delivered, and their consequence is the suppression row below, not
        // a state flip.
        if (messageId && (eventType === 'delivered' || suppressReason || eventType === 'failed'
          || eventType === 'permanent_fail' || eventType === 'rejected')) {
          const writesState = eventType === 'delivered' || eventType === 'failed'
            || eventType === 'permanent_fail' || eventType === 'rejected'
          const status = eventType === 'delivered' ? 'delivered' as const : 'failed' as const
          const flipped = writesState
            ? await inboxMarkDeliveryByProviderId(tx, messageId, status, {
                failedReason: status === 'failed' ? (reasonText || 'Delivery failed') : undefined,
                deliveredAt: status === 'delivered' ? new Date() : undefined
              })
            : null
          const row = flipped ?? await inboxFindOutboundByProviderId(tx, messageId)
          if (row) {
            matched = true
            scopeActed = true
          }
          if (flipped) {
            // Conversation-timeline trail for the state flip — best-effort,
            // a logging failure must not fail (and re-trigger) the webhook.
            try {
              await inboxLogConversationEvent(
                tx,
                flipped.conversation_id,
                status === 'delivered' ? 'inbox_delivery_delivered' : 'inbox_delivery_failed',
                status === 'delivered' ? 'Delivered to recipient' : `Delivery failed${reasonText ? `: ${reasonText}` : ''}`,
                { extra: { providerMessageId: messageId } }
              )
            } catch (err) {
              console.warn('[inbox] delivery-state activity write failed:', err instanceof Error ? err.message : err)
            }
          }
        }

        // 1. Address-level suppression / consent — apply in a scope only when
        // the event is anchored there (user-variable or a correlated
        // message), or when the address is already claimed in that scope.
        // Unanchored events must not claim channels in every org.
        const anchored = !!orgVar || scopeActed
        if ((suppressReason || eventType === 'unsubscribed') && recipient) {
          const channel = anchored
            ? await claimChannel(tx, { channelType: 'email', value: recipient }).catch(() => null)
            : await findScopedChannel(tx, recipient)
          if (channel) {
            if (suppressReason) {
              // Insert-or-refresh: a repeat bounce refreshes the detail and a
              // complaint following a bounce upgrades the reason, instead of
              // being silently dropped against a stale first-write row.
              await recordDeliverySuppression(tx, {
                channelId: channel.id,
                reason: suppressReason,
                detail: reasonText || null,
                source: 'mailgun'
              })
              suppressed = true
              scopeActed = true
              await recordChannelTimeline(
                tx,
                channel.id,
                'email_suppressed',
                `Email suppressed (${suppressReason === 'complaint' ? 'spam complaint' : 'hard bounce'})${reasonText ? ` — ${reasonText}` : ''}`
              )
            }
            if (eventType === 'unsubscribed') {
              await revokeConsent(tx, { userId: null }, {
                channelId: channel.id,
                purpose: 'marketing',
                source: 'mailgun'
              })
              unsubscribed = true
              scopeActed = true
              await recordChannelTimeline(tx, channel.id, 'unsubscribed', 'Unsubscribed from marketing email')
            }
          }
        }

        return scopeActed
      })

      // Message-state correlation matches exactly one org, so stop scanning
      // once a pure delivery/failure event has landed. Address-level
      // suppression and unsubscribe, though, must fan out to EVERY org holding
      // the address — don't break when there's such an action to propagate.
      const needsFanout = !!(suppressReason || eventType === 'unsubscribed')
      if (acted && !orgVar && !needsFanout) break
    }

    if (eventType === 'delivered') return { status: 'delivered', matched }
    if (suppressReason || eventType === 'failed' || eventType === 'permanent_fail' || eventType === 'rejected') {
      return { status: 'failed', matched, suppressed }
    }
    if (eventType === 'unsubscribed') return { status: 'unsubscribed', unsubscribed }
    return { status: 'ignored', event: eventType }
  } catch (error) {
    if (sig.token) inboxReleaseSeenToken(sig.token)
    console.error('[inbox] delivery webhook error:', error instanceof Error ? error.message : error)
    throw createError({ statusCode: 503, statusMessage: 'Temporary failure, please retry' })
  }
})

// Lookup-only channel resolution for unanchored events: acts only on
// addresses this scope has already claimed.
async function findScopedChannel(tx: Transaction<Database>, recipient: string) {
  return await findChannel(tx, { channelType: 'email', value: recipient })
}

// Record-timeline fanout for a channel-level deliverability event: one entry
// per CRM record linked to the channel (a channel usually backs one contact,
// but can back several). Records are the only timeline surface staff see, so
// the entry lands there rather than on the channel. Best-effort — a timeline
// failure must never fail (and re-trigger) the webhook.
async function recordChannelTimeline(
  tx: Transaction<Database>,
  channelId: string,
  action: string,
  note: string
): Promise<void> {
  try {
    const links = await tx
      .selectFrom('crm_contact_channels')
      .select('record_id')
      .where('channel_id', '=', channelId)
      .execute()
    for (const link of links) {
      // recordRecordsActivity only reads ctx.userId; the webhook has no session,
      // so the actor is null with a provider label.
      await recordRecordsActivity(tx, { userId: null } as unknown as TenantContext, link.record_id, action, {
        note,
        actorLabel: 'Mailgun'
      })
    }
  } catch (err) {
    console.warn('[inbox] channel timeline write failed:', err instanceof Error ? err.message : err)
  }
}
