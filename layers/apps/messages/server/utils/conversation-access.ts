// Authorization helpers for conversation access. RLS already gates rows by
// org; these helpers add the per-conversation membership check that's
// specific to messages: channels are visible to all org members; DMs are
// only visible to their participants.

import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { ConversationKind } from '../database/schema.d'

export interface ConversationLite {
  id: string
  kind: ConversationKind
}

export async function loadConversation(
  tx: Transaction<Database>,
  conversationId: string
): Promise<ConversationLite | null> {
  const row = await tx
    .selectFrom('messages_conversations')
    .select(['id', 'kind'])
    .where('id', '=', conversationId)
    .executeTakeFirst()
  return row ?? null
}

export async function userCanAccessConversation(
  tx: Transaction<Database>,
  userId: string,
  conv: ConversationLite
): Promise<boolean> {
  if (conv.kind === 'channel') return true // all org members can see all channels
  // DM: must be a participant
  const member = await tx
    .selectFrom('messages_conversation_members')
    .select('user_id')
    .where('conversation_id', '=', conv.id)
    .where('user_id', '=', userId)
    .executeTakeFirst()
  return !!member
}

// Ids of every conversation the user can see, as a subquery for
// `.where('<alias>.conversation_id', 'in', ...)` in queries spanning many
// conversations. Same rule as userCanAccessConversation.
export function accessibleConversationIds(tx: Transaction<Database>, userId: string) {
  return tx
    .selectFrom('messages_conversations as conv')
    .select('conv.id')
    .where(eb => eb.or([
      eb('conv.kind', '=', 'channel'),
      eb.exists(
        eb.selectFrom('messages_conversation_members as m')
          .select('m.user_id')
          .whereRef('m.conversation_id', '=', 'conv.id')
          .where('m.user_id', '=', userId)
      )
    ]))
}

export async function requireConversationAccess(
  tx: Transaction<Database>,
  userId: string,
  conversationId: string
): Promise<ConversationLite> {
  const conv = await loadConversation(tx, conversationId)
  if (!conv) {
    throw createError({ statusCode: 404, statusMessage: 'Conversation not found.' })
  }
  if (!(await userCanAccessConversation(tx, userId, conv))) {
    throw createError({ statusCode: 403, statusMessage: 'You don\'t have access to this conversation.' })
  }
  return conv
}
