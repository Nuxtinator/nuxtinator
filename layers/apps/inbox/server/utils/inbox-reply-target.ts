// Where a reply to a conversation goes, and whether it can be delivered there.
// One resolver serves both the send sweep (inbox-send-processor.ts) and the
// detail endpoint, so the recipient the composer shows is exactly the one the
// sweep sends to.
import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import { getActiveSuppressions } from '#crm/server'
import type { InboxConversationRow } from './inbox-conversations'

type Tx = Transaction<Database>

export interface InboxReplyTarget {
  channelId: string | null
  email: string | null
}

// The address a queued message goes to: an explicit per-message recipient
// (staff compose sets one) wins, else the conversation's channel address.
// Conversations are channel-strict, so the channel IS the counterparty — a
// held sender who reached the thread via the reply token never becomes the
// target. A null email means there is nothing to send to.
export async function inboxResolveReplyTarget(
  tx: Tx,
  conversation: Pick<InboxConversationRow, 'channel_id'>,
  toEmail?: string | null
): Promise<InboxReplyTarget> {
  const channel = await tx
    .selectFrom('crm_channels')
    .select(['id', 'value'])
    .where('id', '=', conversation.channel_id)
    .executeTakeFirst()
  return { channelId: channel?.id ?? null, email: toEmail || channel?.value || null }
}

export interface InboxReplyStatus {
  email: string | null
  // Address ownership proven (authenticated inbound mail or a redeemed
  // confirmation link).
  verified: boolean
  // The active deliverability suppression on the address, or null when it is
  // mailable. The sweep fails any reply while one stands.
  suppression: { reason: string, detail: string | null, since: Date } | null
}

export async function inboxGetReplyStatus(
  tx: Tx,
  conversation: Pick<InboxConversationRow, 'channel_id'>
): Promise<InboxReplyStatus> {
  const channel = await tx
    .selectFrom('crm_channels')
    .select(['id', 'value', 'verified'])
    .where('id', '=', conversation.channel_id)
    .executeTakeFirst()
  if (!channel) return { email: null, verified: false, suppression: null }
  const active = (await getActiveSuppressions(tx, [channel.id])).get(channel.id)
  return {
    email: channel.value,
    verified: channel.verified,
    suppression: active ? { reason: active.reason, detail: active.detail, since: active.created_at } : null
  }
}
