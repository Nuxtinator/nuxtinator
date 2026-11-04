import type { ColumnType, Generated } from 'kysely'

export interface ContextPortfoliosTable {
  id: Generated<string>
  slug: string
  name: string
  color: string | null
  icon_url: string | null
  order: number | null
  // Registered portfolio template id; null = the default template.
  template: string | null
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>
}

// Whether a section's vector chunks match its current content. 'none' = never
// indexed (or embeddings not configured), 'ok', 'stale' = the last embed
// attempt failed (see index_error) and the chunks describe an older version.
export type ContextSectionIndexState = 'none' | 'ok' | 'stale'

export interface ContextSectionsTable {
  id: Generated<string>
  portfolio_id: string
  section_key: string
  content: Generated<string>
  last_edited_by: string | null
  last_edited_at: ColumnType<Date, Date | string | undefined, Date | string>
  index_state: Generated<ContextSectionIndexState>
  index_error: string | null
}

// One embedded chunk of a section. `embedding` is a pgvector column: written
// through `vectorSql()` from #ai/server, read only via distance expressions.
export interface ContextSectionChunksTable {
  id: Generated<string>
  section_id: string
  portfolio_id: string
  ordinal: number
  heading: Generated<string>
  content: string
  embedding: ColumnType<string, unknown, unknown>
  model: string
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
}

// How a version came to be: a direct edit by the user, an accepted in-app
// assistant proposal, an AI client writing through MCP, or an approved
// suggestion.
export type ContextSectionVersionSource = 'user' | 'assistant' | 'mcp' | 'suggestion'

export interface ContextSectionVersionsTable {
  id: Generated<string>
  section_id: string
  content: string
  edited_by: string | null
  edited_at: ColumnType<Date, Date | string | undefined, Date | string>
  source: ContextSectionVersionSource | null
  suggestion_id: string | null
}

// One row per section a portfolio has. A built-in row stores only its key
// (title/description/order resolve from the portfolio's template unless
// overridden); a custom row stores its own. `created_by` is null for rows
// backfilled by migration.
export interface ContextSectionDefinitionsTable {
  id: Generated<string>
  portfolio_id: string
  key: string
  title: string | null
  description: string | null
  order: number | null
  is_custom: Generated<boolean>
  created_by: string | null
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>
}

export interface ContextSectionCommentsTable {
  id: Generated<string>
  section_id: string
  author_id: string
  quoted_text: string
  anchor_start: number
  anchor_end: number
  anchor_hash: string
  content: string
  is_resolved: Generated<boolean>
  resolved_by: string | null
  resolved_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
}

export interface ContextSectionCommentRepliesTable {
  id: Generated<string>
  comment_id: string
  author_id: string
  content: string
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
}

export type ContextAssistantProposalStatus = 'pending' | 'applied' | 'rejected'

// One section update the assistant proposed in a message. Stored as JSON on
// the message so it can be applied or rejected later; `status` records the
// user's decision.
export interface ContextAssistantProposal {
  portfolio_slug: string
  portfolio_name: string
  section_key: string
  section_title: string
  current_content: string
  proposed_content: string
  status: ContextAssistantProposalStatus
}

export interface ContextAssistantConversationsTable {
  id: Generated<string>
  user_id: string
  portfolio_id: string | null
  section_key: string | null
  title: Generated<string>
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>
}

export interface ContextAssistantMessagesTable {
  id: Generated<string>
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  proposals: Generated<ContextAssistantProposal[]>
  context_loaded: Generated<string[]>
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
}

// `superseded` = replaced by a newer suggestion from the same author for the
// same section.
export type ContextSuggestionStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'superseded'

export interface ContextSuggestionSetsTable {
  id: Generated<string>
  portfolio_id: string
  author_id: string | null
  note: string | null
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
}

export interface ContextSuggestionsTable {
  id: Generated<string>
  set_id: string
  portfolio_id: string
  section_key: string
  base_content: string
  proposed_content: string
  status: ContextSuggestionStatus
  decided_by: string | null
  decided_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>
  review_note: string | null
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
}

declare global {
  interface NuxtinatorDatabaseTables {
    context_portfolios: ContextPortfoliosTable
    context_sections: ContextSectionsTable
    context_section_chunks: ContextSectionChunksTable
    context_section_versions: ContextSectionVersionsTable
    context_section_definitions: ContextSectionDefinitionsTable
    context_section_comments: ContextSectionCommentsTable
    context_section_comment_replies: ContextSectionCommentRepliesTable
    context_assistant_conversations: ContextAssistantConversationsTable
    context_assistant_messages: ContextAssistantMessagesTable
    context_suggestion_sets: ContextSuggestionSetsTable
    context_suggestions: ContextSuggestionsTable
  }
}
