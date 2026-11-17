// Delivery state for inbox mail. Every inbox send carries its message row id
// as `ref`, so a provider event names the exact message. The event's org is
// trusted per the kernel's rules (an org-owned account's events always carry
// that account's org), and the lookup runs inside that org's RLS scope, so an
// event can only ever touch its own org's messages.
//
// Only delivery outcomes write state: delivered, and permanent
// bounced/rejected/dropped → failed. A failure never downgrades an
// already-delivered message. Suppressions and consent are not the inbox's
// job: the kernel records suppressions and CRM revokes consent.
import type { MailEvent } from '@nuxtinator/mail/kernel'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function inboxHandleDeliveryEvent(event: MailEvent): Promise<void> {
  if (!event.ref || !UUID_RE.test(event.ref)) return
  const delivered = event.type === 'delivered'
  const failed = event.permanent && (event.type === 'bounced' || event.type === 'rejected' || event.type === 'dropped')
  if (!delivered && !failed) return

  const status = delivered ? 'delivered' as const : 'failed' as const
  const reason = event.detail || 'Delivery failed'
  await inboxWithScopeTx(event.orgId, async (tx) => {
    const flipped = await inboxMarkDelivery(tx, event.ref!, status, {
      failedReason: failed ? reason : undefined,
      deliveredAt: delivered ? event.occurredAt : undefined
    })
    if (!flipped) return
    // Conversation-timeline trail for the state flip — best-effort, a logging
    // failure must not fail (and re-trigger) the event.
    try {
      await inboxLogConversationEvent(
        tx,
        flipped.conversation_id,
        delivered ? 'inbox_delivery_delivered' : 'inbox_delivery_failed',
        delivered ? 'Delivered to recipient' : `Delivery failed${event.detail ? `: ${event.detail}` : ''}`,
        { extra: { providerMessageId: event.providerMessageId } }
      )
    } catch (err) {
      console.warn('[inbox] delivery-state activity write failed:', err instanceof Error ? err.message : err)
    }
  })
}
