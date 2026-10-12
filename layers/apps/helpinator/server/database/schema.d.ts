import type { ColumnType, Generated } from 'kysely'

// Appearance of one widget. Every field optional in storage — the public
// config fills the defaults (see server/utils/helpinator-widgets.ts).
export interface HelpinatorAppearance {
  primary_color?: string
  position?: 'bottom-right' | 'bottom-left'
  title?: string
  greeting?: string
  placeholder?: string
  handoff_prompt?: string
}

export type HelpinatorLibraryKind = 'website' | 'portfolio'
export type HelpinatorSourceStatus = 'idle' | 'syncing' | 'done' | 'error'

export interface HelpinatorLibrariesTable {
  id: Generated<string>
  name: string
  kind: HelpinatorLibraryKind
  portfolio_id: string | null
  description: Generated<string>
  created_by: string | null
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>
}

export interface HelpinatorLibrarySourcesTable {
  id: Generated<string>
  library_id: string
  url: string
  restrict_to_path: Generated<boolean>
  max_pages: Generated<number>
  max_page_mb: Generated<number>
  max_depth: Generated<number>
  status: Generated<HelpinatorSourceStatus>
  run_token: string | null
  run_started_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>
  run_heartbeat_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>
  page_count: Generated<number>
  bytes: Generated<number>
  run_total: Generated<number>
  run_done: Generated<number>
  last_synced_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>
  last_error: string | null
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
}

export interface HelpinatorLibraryPagesTable {
  id: Generated<string>
  library_id: string
  source_id: string
  url: string
  title: Generated<string>
  content: Generated<string>
  content_hash: string
  bytes: Generated<number>
  fetched_at: ColumnType<Date, Date | string | undefined, Date | string>
}

// `embedding` is a pgvector column: written through `vectorSql()` from
// #ai/server, read only via distance expressions.
export interface HelpinatorLibraryChunksTable {
  id: Generated<string>
  page_id: string
  library_id: string
  ordinal: number
  heading: Generated<string>
  content: string
  embedding: ColumnType<string, unknown, unknown>
  model: string
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
}

export interface HelpinatorWidgetsTable {
  id: Generated<string>
  name: string
  // The libraries the bot may search and read; `default_library_id` is one
  // of them and its index sits in the cached prompt.
  library_ids: Generated<string[]>
  default_library_id: string | null
  // Preloaded section when the default library is a portfolio.
  default_section_key: string | null
  allowed_origins: Generated<string[]>
  daily_message_cap: Generated<number>
  enabled: Generated<boolean>
  appearance: ColumnType<HelpinatorAppearance, HelpinatorAppearance | string | undefined, HelpinatorAppearance | string>
  extra_instructions: Generated<string>
  // Clickable suggestions shown before the visitor's first message.
  starter_questions: Generated<string[]>
  created_by: string | null
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>
}

// handoff_kind: 'visitor' (self-service "still need help") | 'staff' (manual elevation, since removed; older rows only)
export type HelpinatorHandoffKind = 'visitor' | 'staff'

export interface HelpinatorConversationsTable {
  id: Generated<string>
  widget_id: string
  // Snapshot of the widget's binding at creation.
  library_ids: Generated<string[]>
  default_library_id: string | null
  session_hash: string
  visitor_email: string | null
  page_url: string | null
  origin: string | null
  user_agent: string | null
  visitor_message_count: Generated<number>
  inbox_conversation_id: string | null
  handoff_kind: HelpinatorHandoffKind | null
  handed_off_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>
  handed_off_by: string | null
  ended_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
  last_message_at: ColumnType<Date, Date | string | undefined, Date | string>
}

// What the bot read for a reply: `ref` is the load_page ref (page:<id> or
// section:<library>:<key>), `title` the human label, `url` a website page's
// address (absent for portfolio sections).
export interface HelpinatorPageLoaded {
  ref: string
  title: string
  url?: string
}

// A page search surfaced for a reply; same shape as a loaded page.
export type HelpinatorSearchHitLogged = HelpinatorPageLoaded

export interface HelpinatorMessagesTable {
  id: Generated<string>
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  pages_loaded: ColumnType<HelpinatorPageLoaded[], HelpinatorPageLoaded[] | string | undefined, HelpinatorPageLoaded[] | string>
  searches: ColumnType<string[], string[] | string | undefined, string[] | string>
  search_hits: ColumnType<HelpinatorSearchHitLogged[], HelpinatorSearchHitLogged[] | string | undefined, HelpinatorSearchHitLogged[] | string>
  model: string | null
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
}

declare global {
  interface NuxtinatorDatabaseTables {
    helpinator_libraries: HelpinatorLibrariesTable
    helpinator_library_sources: HelpinatorLibrarySourcesTable
    helpinator_library_pages: HelpinatorLibraryPagesTable
    helpinator_library_chunks: HelpinatorLibraryChunksTable
    helpinator_widgets: HelpinatorWidgetsTable
    helpinator_conversations: HelpinatorConversationsTable
    helpinator_messages: HelpinatorMessagesTable
  }
}
