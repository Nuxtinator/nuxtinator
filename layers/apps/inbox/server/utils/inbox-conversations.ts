// Conversation service. Everything takes the caller's tenant/scope
// transaction — the org GUC (and therefore current_org_id(), the DEFAULT for
// org_id) exists only inside it. Conversations key on crm_channels: the
// counterparty is an address identity, not a contact record. Joins to crm
// tables run inside the same org transaction, so RLS composes.
import { randomBytes } from 'node:crypto'
import { sql } from 'kysely'
import type { Expression, ExpressionBuilder, Selectable, SqlBool, Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'

type Tx = Transaction<Database>

export type InboxConversationRow = Selectable<Database['inbox_conversations']>

export const INBOX_CONVERSATION_STATUSES = ['open', 'pending', 'closed', 'spam'] as const
export type InboxConversationStatusValue = typeof INBOX_CONVERSATION_STATUSES[number]

// List rows carry everything the list pane renders, resolved in one query.
export interface InboxConversationListItem extends InboxConversationRow {
  channel_value: string
  assignee_name: string | null
  message_count: number
  last_message_snippet: string | null
}

export interface InboxConversationFilters {
  status?: InboxConversationStatusValue
  assignedUserId?: string
  unassigned?: boolean
  mine?: string
  held?: boolean
  search?: string
  // A single channel, or several — the contact-record panel surfaces every
  // thread across all of a contact's linked email addresses (channel-strict
  // threading forks a thread per address).
  channelId?: string | string[]
  tag?: string
  // Last activity on or after / before these moments.
  since?: Date
  until?: Date
  // Matches the counterparty's From name or address.
  sender?: string
  limit?: number
  offset?: number
}

function generateReplyToken(): string {
  // 10 bytes (80-bit) hex — unguessable, short enough that future signed
  // reply variants stay within the 64-char local-part limit, and globally
  // unique across orgs (the token→org webhook lookup depends on that).
  return randomBytes(10).toString('hex')
}

export async function inboxCreateConversation(
  tx: Tx,
  data: {
    channelId: string
    subject?: string | null
    status?: InboxConversationStatusValue
    assignedUserId?: string | null
    needsReview?: boolean
    source: string
    counterpartyName?: string | null
  }
): Promise<InboxConversationRow> {
  return await tx
    .insertInto('inbox_conversations')
    .values({
      channel_id: data.channelId,
      subject: data.subject ?? null,
      status: data.status ?? 'open',
      assigned_user_id: data.assignedUserId ?? null,
      reply_token: generateReplyToken(),
      needs_review: data.needsReview ?? false,
      source: data.source,
      counterparty_name: data.counterpartyName ?? null
    })
    .returningAll()
    .executeTakeFirstOrThrow()
}

export async function inboxGetConversation(tx: Tx, id: string): Promise<InboxConversationRow | null> {
  const row = await tx
    .selectFrom('inbox_conversations')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst()
  return row ?? null
}

export async function inboxFindByReplyToken(tx: Tx, token: string): Promise<InboxConversationRow | null> {
  const row = await tx
    .selectFrom('inbox_conversations')
    .selectAll()
    .where('reply_token', '=', token)
    .executeTakeFirst()
  return row ?? null
}

// Most recent conversation for a channel — used to reuse a spam thread for
// repeat blocked senders instead of spawning a new conversation per message.
export async function inboxGetLatestForChannel(tx: Tx, channelId: string): Promise<InboxConversationRow | null> {
  const row = await tx
    .selectFrom('inbox_conversations')
    .selectAll()
    .where('channel_id', '=', channelId)
    .orderBy(sql`last_message_at DESC NULLS LAST`)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  return row ?? null
}

// Most recent message-less conversation for a channel, created within the
// window. A message-less conversation only exists because a prior inbound
// failed after the conversation row was created; reusing it lets a provider's
// retries converge on one conversation instead of spawning a fresh empty
// shell each time.
export async function inboxGetRecentEmptyForChannel(
  tx: Tx,
  channelId: string,
  withinHours = 24
): Promise<InboxConversationRow | null> {
  const row = await tx
    .selectFrom('inbox_conversations as c')
    .selectAll('c')
    .where('c.channel_id', '=', channelId)
    .where('c.created_at', '>', sql<Date>`now() - (${withinHours} * interval '1 hour')`)
    .where(({ not, exists, selectFrom }) => not(exists(
      selectFrom('inbox_messages as m').select('m.id').whereRef('m.conversation_id', '=', 'c.id')
    )))
    .orderBy('c.created_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  return row ?? null
}

type ConversationEb = ExpressionBuilder<Database, 'inbox_conversations'>

function filterConditions(eb: ConversationEb, filters: InboxConversationFilters): Expression<SqlBool>[] {
  const conds: Expression<SqlBool>[] = []
  if (filters.status) conds.push(eb('inbox_conversations.status', '=', filters.status))
  if (filters.held) conds.push(eb('inbox_conversations.needs_review', '=', true))
  if (filters.unassigned) conds.push(eb('inbox_conversations.assigned_user_id', 'is', null))
  if (filters.mine) conds.push(eb('inbox_conversations.assigned_user_id', '=', filters.mine))
  if (filters.assignedUserId) conds.push(eb('inbox_conversations.assigned_user_id', '=', filters.assignedUserId))
  if (filters.channelId !== undefined) {
    const ids = Array.isArray(filters.channelId) ? filters.channelId : [filters.channelId]
    // An empty set matches nothing (never widen to the whole table).
    conds.push(ids.length ? eb('inbox_conversations.channel_id', 'in', ids) : sql<SqlBool>`false`)
  }
  // Containment (@>) — a conversation matches when the slug is anywhere in its
  // tags array. Bound as text then cast to sidestep postgres-js jsonb encoding.
  if (filters.tag) conds.push(sql<SqlBool>`inbox_conversations.tags @> ${JSON.stringify([filters.tag])}::text::jsonb`)
  if (filters.since) conds.push(eb('inbox_conversations.last_message_at', '>=', filters.since))
  if (filters.until) conds.push(eb('inbox_conversations.last_message_at', '<', filters.until))
  if (filters.sender) {
    const term = `%${filters.sender}%`
    conds.push(sql<SqlBool>`(
      inbox_conversations.counterparty_name ILIKE ${term}
      OR EXISTS (
        SELECT 1 FROM crm_channels ch
        WHERE ch.id = inbox_conversations.channel_id AND ch.value ILIKE ${term}
      )
    )`)
  }
  if (filters.search) {
    const term = `%${filters.search}%`
    // Match the subject, the denormalized From name, the conversation's own
    // channel value, the linked CRM contact's record name, and any sibling
    // channel value on that contact (so "John Smith" finds a thread whose From
    // header only carried "JS", and a search by the contact's phone/second
    // address finds their email threads). All joins run inside the org tx, so
    // RLS scopes them.
    conds.push(sql<SqlBool>`(
      inbox_conversations.subject ILIKE ${term}
      OR inbox_conversations.counterparty_name ILIKE ${term}
      OR EXISTS (
        SELECT 1 FROM crm_channels ch
        WHERE ch.id = inbox_conversations.channel_id AND ch.value ILIKE ${term}
      )
      OR EXISTS (
        SELECT 1 FROM crm_contact_channels cc
        JOIN crm_records r ON r.id = cc.record_id
        WHERE cc.channel_id = inbox_conversations.channel_id AND r.name ILIKE ${term}
      )
      OR EXISTS (
        SELECT 1 FROM crm_contact_channels cc
        JOIN crm_contact_channels sib ON sib.record_id = cc.record_id
        JOIN crm_channels sch ON sch.id = sib.channel_id
        WHERE cc.channel_id = inbox_conversations.channel_id AND sch.value ILIKE ${term}
      )
    )`)
  }
  return conds
}

export async function inboxListConversations(
  tx: Tx,
  filters: InboxConversationFilters = {}
): Promise<InboxConversationListItem[]> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100)
  const offset = Math.max(filters.offset ?? 0, 0)

  const q = tx
    .selectFrom('inbox_conversations')
    .innerJoin('crm_channels', 'crm_channels.id', 'inbox_conversations.channel_id')
    .leftJoin('users', 'users.id', 'inbox_conversations.assigned_user_id')
    .selectAll('inbox_conversations')
    .select([
      'crm_channels.value as channel_value',
      'users.display_name as assignee_name',
      sql<number>`(
        SELECT COUNT(*)::int FROM inbox_messages m
        WHERE m.conversation_id = inbox_conversations.id AND m.status <> 'draft'
      )`.as('message_count'),
      sql<string | null>`(
        -- Tags become spaces (not ''), then whitespace collapses — adjacent
        -- blocks must not jam into one word in the snippet.
        SELECT LEFT(COALESCE(m.body_text, btrim(regexp_replace(regexp_replace(COALESCE(m.body_stripped_html, m.body_html, ''), '<[^>]*>', ' ', 'g'), '\\s+', ' ', 'g'))), 160)
        FROM inbox_messages m
        WHERE m.conversation_id = inbox_conversations.id AND m.status <> 'draft'
        ORDER BY m.created_at DESC LIMIT 1
      )`.as('last_message_snippet')
    ])
    .where(eb => eb.and(filterConditions(eb, filters)))

  const rows = await q
    .orderBy(sql`inbox_conversations.last_message_at DESC NULLS LAST`)
    .orderBy('inbox_conversations.created_at', 'desc')
    .limit(limit)
    .offset(offset)
    .execute()
  return rows as InboxConversationListItem[]
}

export async function inboxCountConversations(tx: Tx, filters: InboxConversationFilters = {}): Promise<number> {
  const row = await tx
    .selectFrom('inbox_conversations')
    .select(({ fn }) => fn.countAll<string>().as('count'))
    .where(eb => eb.and(filterConditions(eb, filters)))
    .executeTakeFirst()
  return Number(row?.count ?? 0)
}

// Rail badge counts (ignores search). The all/unassigned/mine tallies respect
// the status filter so they match the visible list. `held` (needs-review) is
// status-independent — it's an alarm for the whole review queue. The
// open/pending badges reflect the active scope rail so each number matches
// what the list will show when that tab is opened.
export async function inboxConversationCounts(
  tx: Tx,
  opts: {
    status?: InboxConversationStatusValue
    mine?: string
    scope?: 'all' | 'unassigned' | 'mine' | 'held'
  } = {}
): Promise<{ all: number, unassigned: number, mine: number, held: number, open: number, pending: number }> {
  const statusCond = opts.status ? sql`c.status = ${opts.status}` : sql`TRUE`
  const mineId = opts.mine ?? null
  const scopeCond = (() => {
    if (opts.scope === 'unassigned') return sql`c.assigned_user_id IS NULL`
    if (opts.scope === 'mine') {
      // "Mine" with no user id is meaningless — count zero rather than
      // silently widening to the whole table.
      return mineId ? sql`c.assigned_user_id = ${mineId}` : sql`FALSE`
    }
    if (opts.scope === 'held') return sql`c.needs_review = true`
    return sql`TRUE`
  })()

  const result = await sql<{
    all: string, unassigned: string, mine: string, held: string, open: string, pending: string
  }>`
    SELECT
      COUNT(*) FILTER (WHERE ${statusCond}) AS all,
      COUNT(*) FILTER (WHERE ${statusCond} AND c.assigned_user_id IS NULL) AS unassigned,
      COUNT(*) FILTER (WHERE ${statusCond} AND c.assigned_user_id = ${mineId}) AS mine,
      COUNT(*) FILTER (WHERE c.needs_review = true) AS held,
      COUNT(*) FILTER (WHERE c.status = 'open' AND ${scopeCond}) AS open,
      COUNT(*) FILTER (WHERE c.status = 'pending' AND ${scopeCond}) AS pending
    FROM inbox_conversations c
  `.execute(tx)
  const row = result.rows[0]
  return {
    all: Number(row?.all ?? 0),
    unassigned: Number(row?.unassigned ?? 0),
    mine: Number(row?.mine ?? 0),
    held: Number(row?.held ?? 0),
    open: Number(row?.open ?? 0),
    pending: Number(row?.pending ?? 0)
  }
}

export async function inboxUpdateConversationStatus(
  tx: Tx,
  id: string,
  status: InboxConversationStatusValue
): Promise<InboxConversationRow | null> {
  const row = await tx
    .updateTable('inbox_conversations')
    .set({ status, updated_at: new Date() })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst()
  return row ?? null
}

export async function inboxAssignConversation(
  tx: Tx,
  id: string,
  userId: string | null
): Promise<InboxConversationRow | null> {
  const row = await tx
    .updateTable('inbox_conversations')
    .set({ assigned_user_id: userId, updated_at: new Date() })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst()
  return row ?? null
}

// Assign only if currently unassigned (used on agent reply). Returns true if
// it set the owner.
export async function inboxAssignIfUnassigned(tx: Tx, id: string, userId: string): Promise<boolean> {
  const result = await tx
    .updateTable('inbox_conversations')
    .set({ assigned_user_id: userId, updated_at: new Date() })
    .where('id', '=', id)
    .where('assigned_user_id', 'is', null)
    .executeTakeFirst()
  return Number(result.numUpdatedRows ?? 0) > 0
}

export async function inboxSetNeedsReview(tx: Tx, id: string, value: boolean): Promise<void> {
  await tx
    .updateTable('inbox_conversations')
    .set({ needs_review: value, updated_at: new Date() })
    .where('id', '=', id)
    .execute()
}

// Fill the subject only when empty — the first inbound wins; later
// subject-line edits by the contact's mail client don't rename the thread.
export async function inboxSetSubjectIfEmpty(tx: Tx, id: string, subject: string): Promise<void> {
  await tx
    .updateTable('inbox_conversations')
    .set({ subject, updated_at: new Date() })
    .where('id', '=', id)
    .where(eb => eb.or([
      eb('subject', 'is', null),
      eb('subject', '=', '')
    ]))
    .execute()
}

export async function inboxTouchLastMessage(
  tx: Tx,
  id: string,
  at: Date,
  direction: 'inbound' | 'outbound',
  opts: { counterpartyName?: string | null } = {}
): Promise<void> {
  await tx
    .updateTable('inbox_conversations')
    .set({
      last_message_at: at,
      last_message_direction: direction,
      // The denormalized display name follows the latest inbound sender.
      ...(opts.counterpartyName ? { counterparty_name: opts.counterpartyName } : {}),
      updated_at: new Date()
    })
    .where('id', '=', id)
    .execute()
}

// Auto-close all of a channel's conversations as spam (used when blocking a
// sender / inbound from a blocklisted sender). Returns how many flipped.
export async function inboxCloseForChannelAsSpam(tx: Tx, channelId: string): Promise<number> {
  const result = await tx
    .updateTable('inbox_conversations')
    .set({ status: 'spam', updated_at: new Date() })
    .where('channel_id', '=', channelId)
    .where('status', '!=', 'spam')
    .executeTakeFirst()
  return Number(result.numUpdatedRows ?? 0)
}

// Reverse of the spam verdict: reopen every conversation the spam flip
// closed. Threads return to 'closed' (not 'open') — the triage queue
// shouldn't flood when unblocking; the next inbound reopens naturally.
export async function inboxReopenFromSpam(tx: Tx, channelId: string): Promise<number> {
  const result = await tx
    .updateTable('inbox_conversations')
    .set({ status: 'closed', updated_at: new Date() })
    .where('channel_id', '=', channelId)
    .where('status', '=', 'spam')
    .executeTakeFirst()
  return Number(result.numUpdatedRows ?? 0)
}

// Close pending conversations quiet for longer than `quietDays`. Pending means
// "we replied, awaiting theirs" — a contact reply reopens even a closed
// thread, so timing out is safe. Held (needs-review) rows are an alarm that
// must not expire, and a NULL last_message_at means nothing was ever sent
// (drafts don't touch it); both are left alone. Returns the closed ids.
export async function inboxAutoCloseStalePending(tx: Tx, quietDays: number): Promise<string[]> {
  const rows = await tx
    .updateTable('inbox_conversations')
    .set({ status: 'closed', updated_at: new Date() })
    .where('status', '=', 'pending')
    .where('needs_review', '=', false)
    .where('last_message_at', 'is not', null)
    .where('last_message_at', '<', sql<Date>`now() - (${quietDays} * interval '1 day')`)
    .returning('id')
    .execute()
  return rows.map(r => r.id)
}

// Bulk triage over a set of ids. Each helper returns the ids it actually
// changed (missing ids — and ones RLS hides — are skipped) so callers can log
// per conversation. Spam is never entered or left here: that transition is
// the sender-blocklist toggle and stays a deliberate per-conversation action.
export async function inboxBulkUpdateStatus(
  tx: Tx,
  ids: string[],
  status: Exclude<InboxConversationStatusValue, 'spam'>
): Promise<{ id: string, from: string }[]> {
  if (ids.length === 0) return []
  const current = await tx
    .selectFrom('inbox_conversations')
    .select(['id', 'status'])
    .where('id', 'in', ids)
    .where('status', '!=', 'spam')
    .where('status', '!=', status)
    .execute()
  if (current.length === 0) return []
  await tx
    .updateTable('inbox_conversations')
    .set({ status, updated_at: new Date() })
    .where('id', 'in', current.map(c => c.id))
    .execute()
  return current.map(c => ({ id: c.id, from: c.status }))
}

export async function inboxBulkAssign(tx: Tx, ids: string[], userId: string | null): Promise<string[]> {
  if (ids.length === 0) return []
  const rows = await tx
    .updateTable('inbox_conversations')
    .set({ assigned_user_id: userId, updated_at: new Date() })
    .where('id', 'in', ids)
    .returning('id')
    .execute()
  return rows.map(r => r.id)
}

export async function inboxBulkClearNeedsReview(tx: Tx, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await tx
    .updateTable('inbox_conversations')
    .set({ needs_review: false, updated_at: new Date() })
    .where('id', 'in', ids)
    .execute()
}
