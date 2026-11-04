// GET /api/messages/conversations
// Returns: { channels: [...], dms: [...] }
// Each entry includes unread_count derived from messages_conversation_reads.

import { sql } from 'kysely'
import { withOrgPermission } from '#tenant/server'

interface ChannelRow {
  id: string
  name: string | null
  description: string | null
  subscribed: boolean
  muted: boolean
  unread_count: number
}

interface DmRow {
  id: string
  unread_count: number
  members: Array<{ id: string, display_name: string, avatar: string }>
}

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'messages' }, 'messages.read', async (tx, ctx) => {
    // Channels: one query that joins the user's subscription + read pointer
    // and aggregates unread item count via FILTER (...) — one round-trip
    // total, instead of one per channel.
    const channelRows = await tx
      .selectFrom('messages_conversations as c')
      .leftJoin('messages_channel_subscriptions as sub', join =>
        join.onRef('sub.channel_id', '=', 'c.id').on('sub.user_id', '=', ctx.userId))
      .leftJoin('messages_conversation_reads as r', join =>
        join.onRef('r.conversation_id', '=', 'c.id').on('r.user_id', '=', ctx.userId))
      .leftJoin('messages_items as i', join =>
        join
          .onRef('i.conversation_id', '=', 'c.id')
          .on('i.deleted_at', 'is', null)
          .on('i.author_id', '!=', ctx.userId))
      .select([
        'c.id',
        'c.name',
        'c.description',
        eb => eb('sub.subscribed', 'is', true).as('subscribed'),
        // muted = an explicit opt-out row (subscribed = false). A missing row
        // (never touched) is neither subscribed nor muted.
        eb => eb('sub.subscribed', 'is', false).as('muted'),
        sql<string>`count(i.id) FILTER (WHERE i.created_at > coalesce(r.last_read_at, 'epoch'::timestamptz))`.as('unread_count')
      ])
      .where('c.kind', '=', 'channel')
      .where('c.archived_at', 'is', null)
      .groupBy(['c.id', 'c.name', 'c.description', 'sub.subscribed'])
      .orderBy('c.name', 'asc')
      .execute()

    const channels: ChannelRow[] = channelRows.map(row => ({
      id: row.id,
      name: row.name,
      description: row.description,
      subscribed: !!row.subscribed,
      muted: !!row.muted,
      unread_count: Number(row.unread_count ?? 0)
    }))

    // DMs: same shape as channels (single aggregated query for unread counts).
    const dmAggRows = await tx
      .selectFrom('messages_conversations as c')
      .innerJoin('messages_conversation_members as m_self', join =>
        join.onRef('m_self.conversation_id', '=', 'c.id').on('m_self.user_id', '=', ctx.userId))
      .leftJoin('messages_conversation_reads as r', join =>
        join.onRef('r.conversation_id', '=', 'c.id').on('r.user_id', '=', ctx.userId))
      .leftJoin('messages_items as i', join =>
        join
          .onRef('i.conversation_id', '=', 'c.id')
          .on('i.deleted_at', 'is', null)
          .on('i.author_id', '!=', ctx.userId))
      .select([
        'c.id',
        sql<string>`count(i.id) FILTER (WHERE i.created_at > coalesce(r.last_read_at, 'epoch'::timestamptz))`.as('unread_count')
      ])
      .where('c.kind', '=', 'dm')
      .where('c.archived_at', 'is', null)
      .groupBy('c.id')
      .execute()

    // One members lookup for every DM in scope, then group by conversation.
    const dmIds = dmAggRows.map(r => r.id)
    const memberRows = dmIds.length > 0
      ? await tx
        .selectFrom('messages_conversation_members as m')
        .innerJoin('users', 'users.id', 'm.user_id')
        .select(['m.conversation_id', 'users.id', 'users.display_name', 'users.avatar'])
        .where('m.conversation_id', 'in', dmIds)
        .execute()
      : []

    const membersByConv = new Map<string, Array<{ id: string, display_name: string, avatar: string }>>()
    for (const r of memberRows) {
      const arr = membersByConv.get(r.conversation_id) ?? []
      arr.push({ id: r.id, display_name: r.display_name, avatar: r.avatar })
      membersByConv.set(r.conversation_id, arr)
    }

    const dms: DmRow[] = dmAggRows.map(row => ({
      id: row.id,
      unread_count: Number(row.unread_count ?? 0),
      members: membersByConv.get(row.id) ?? []
    }))

    return { channels, dms }
  })
})
