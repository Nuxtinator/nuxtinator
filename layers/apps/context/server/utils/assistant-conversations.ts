// Persistence for assistant chats: conversations (one per user + scope) and
// their messages. Every reader takes the owner's user id so a conversation is
// only ever visible to the user who started it; the tenant transaction
// restricts visibility to the active org on top of that.

import { sql, type Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { ContextAssistantProposal, ContextAssistantProposalStatus } from '../database/schema'

type Tx = Transaction<Database>

export interface ConversationScope {
  portfolioId: string | null
  sectionKey: string | null
}

export interface ConversationRow {
  id: string
  user_id: string
  portfolio_id: string | null
  section_key: string | null
  title: string
  created_at: Date
  updated_at: Date
}

export interface ConversationListItem extends ConversationRow {
  portfolio_slug: string | null
  portfolio_name: string | null
  message_count: number
}

export interface MessageRow {
  id: string
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  proposals: ContextAssistantProposal[]
  context_loaded: string[]
  created_at: Date
}

const CONVERSATION_COLUMNS = [
  'context_assistant_conversations.id',
  'context_assistant_conversations.user_id',
  'context_assistant_conversations.portfolio_id',
  'context_assistant_conversations.section_key',
  'context_assistant_conversations.title',
  'context_assistant_conversations.created_at',
  'context_assistant_conversations.updated_at'
] as const

const MESSAGE_COLUMNS = ['id', 'conversation_id', 'role', 'content', 'proposals', 'context_loaded', 'created_at'] as const

export const MAX_CONVERSATIONS_LISTED = 50

export async function listConversations(
  tx: Tx,
  userId: string,
  scope: ConversationScope
): Promise<ConversationListItem[]> {
  let q = tx
    .selectFrom('context_assistant_conversations')
    .leftJoin('context_portfolios', 'context_portfolios.id', 'context_assistant_conversations.portfolio_id')
    .select([
      ...CONVERSATION_COLUMNS,
      'context_portfolios.slug as portfolio_slug',
      'context_portfolios.name as portfolio_name',
      sql<number>`(
        SELECT count(*)::int FROM context_assistant_messages m
        WHERE m.conversation_id = context_assistant_conversations.id
      )`.as('message_count')
    ])
    .where('context_assistant_conversations.user_id', '=', userId)
    .orderBy('context_assistant_conversations.updated_at', 'desc')
    .limit(MAX_CONVERSATIONS_LISTED)

  q = scope.portfolioId
    ? q.where('context_assistant_conversations.portfolio_id', '=', scope.portfolioId)
    : q.where('context_assistant_conversations.portfolio_id', 'is', null)
  q = scope.sectionKey
    ? q.where('context_assistant_conversations.section_key', '=', scope.sectionKey)
    : q.where('context_assistant_conversations.section_key', 'is', null)

  const rows = await q.execute()
  return rows as ConversationListItem[]
}

export async function createConversation(
  tx: Tx,
  userId: string,
  scope: ConversationScope
): Promise<ConversationRow> {
  const row = await tx
    .insertInto('context_assistant_conversations')
    .values({
      user_id: userId,
      portfolio_id: scope.portfolioId,
      section_key: scope.sectionKey
    })
    .returning(['id', 'user_id', 'portfolio_id', 'section_key', 'title', 'created_at', 'updated_at'])
    .executeTakeFirstOrThrow()
  return row as ConversationRow
}

export async function getOwnedConversation(
  tx: Tx,
  id: string,
  userId: string
): Promise<ConversationRow | null> {
  const row = await tx
    .selectFrom('context_assistant_conversations')
    .select(['id', 'user_id', 'portfolio_id', 'section_key', 'title', 'created_at', 'updated_at'])
    .where('id', '=', id)
    .where('user_id', '=', userId)
    .executeTakeFirst()
  return (row as ConversationRow | undefined) ?? null
}

export async function getOwnedConversationOr404(tx: Tx, id: string, userId: string): Promise<ConversationRow> {
  const row = await getOwnedConversation(tx, id, userId)
  if (!row) {
    throw createError({ statusCode: 404, statusMessage: 'Conversation not found.' })
  }
  return row
}

export async function deleteConversation(tx: Tx, id: string, userId: string): Promise<boolean> {
  const res = await tx
    .deleteFrom('context_assistant_conversations')
    .where('id', '=', id)
    .where('user_id', '=', userId)
    .executeTakeFirst()
  return Number(res.numDeletedRows) > 0
}

export async function listMessages(tx: Tx, conversationId: string): Promise<MessageRow[]> {
  const rows = await tx
    .selectFrom('context_assistant_messages')
    .select(MESSAGE_COLUMNS)
    .where('conversation_id', '=', conversationId)
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute()
  return rows as MessageRow[]
}

export async function getMessageInConversation(
  tx: Tx,
  conversationId: string,
  messageId: string
): Promise<MessageRow | null> {
  const row = await tx
    .selectFrom('context_assistant_messages')
    .select(MESSAGE_COLUMNS)
    .where('conversation_id', '=', conversationId)
    .where('id', '=', messageId)
    .executeTakeFirst()
  return (row as MessageRow | undefined) ?? null
}

export interface InsertMessageInput {
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  proposals?: ContextAssistantProposal[]
  contextLoaded?: string[]
}

export async function insertMessage(tx: Tx, input: InsertMessageInput): Promise<MessageRow> {
  const row = await tx
    .insertInto('context_assistant_messages')
    .values({
      conversation_id: input.conversationId,
      role: input.role,
      content: input.content,
      // `::text::jsonb` so the driver binds a JSON document, not a quoted
      // string scalar.
      proposals: sql`${JSON.stringify(input.proposals ?? [])}::text::jsonb`,
      context_loaded: sql`${JSON.stringify(input.contextLoaded ?? [])}::text::jsonb`,
      // Wall-clock time rather than the column default: both turns of an
      // exchange are inserted in one transaction, where `now()` is the same
      // for each, and the list orders by this column.
      created_at: sql`clock_timestamp()`
    })
    .returning(MESSAGE_COLUMNS)
    .executeTakeFirstOrThrow()
  return row as MessageRow
}

// Bump `updated_at` so the conversation sorts to the top of its scope's list,
// and give an untitled conversation its title from the first user message.
export async function touchConversation(tx: Tx, id: string, firstUserMessage?: string): Promise<void> {
  if (firstUserMessage !== undefined) {
    await tx
      .updateTable('context_assistant_conversations')
      .set({ title: deriveTitle(firstUserMessage) })
      .where('id', '=', id)
      .where('title', '=', '')
      .execute()
  }
  await tx
    .updateTable('context_assistant_conversations')
    .set({ updated_at: sql<Date>`now()` })
    .where('id', '=', id)
    .execute()
}

export function deriveTitle(message: string): string {
  const line = message.replace(/\s+/g, ' ').trim()
  return line.length > 80 ? `${line.slice(0, 77)}…` : line
}

export async function setProposalStatus(
  tx: Tx,
  message: MessageRow,
  index: number,
  status: ContextAssistantProposalStatus
): Promise<ContextAssistantProposal[]> {
  const proposals = message.proposals.map((p, i) => (i === index ? { ...p, status } : p))
  await tx
    .updateTable('context_assistant_messages')
    .set({ proposals: sql`${JSON.stringify(proposals)}::text::jsonb` })
    .where('id', '=', message.id)
    .execute()
  return proposals
}
