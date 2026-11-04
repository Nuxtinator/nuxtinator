export interface HelpinatorAppearanceForm {
  primary_color: string
  position: 'bottom-right' | 'bottom-left'
  title: string
  greeting: string
  placeholder: string
  handoff_prompt: string
}

export type HelpinatorLibraryKind = 'website' | 'portfolio'
export type HelpinatorSourceStatus = 'idle' | 'syncing' | 'done' | 'error'

export interface HelpinatorLibrary {
  id: string
  name: string
  kind: HelpinatorLibraryKind
  portfolio_id: string | null
  description: string
  created_at: string
  updated_at: string
}

export interface HelpinatorLibraryStats {
  pages: number
  chunks: number
  bytes: number
  models: string[]
}

export interface HelpinatorLibrarySummary extends HelpinatorLibrary {
  stats: HelpinatorLibraryStats
  source_count: number
}

export interface HelpinatorSource {
  id: string
  library_id: string
  url: string
  restrict_to_path: boolean
  max_pages: number
  max_page_mb: number
  // Links followed from the start page: 0 = the page alone.
  max_depth: number
  status: HelpinatorSourceStatus
  run_started_at: string | null
  page_count: number
  bytes: number
  // Progress of the run in flight (meaningful while status is 'syncing').
  run_total: number
  run_done: number
  last_synced_at: string | null
  last_error: string | null
  created_at: string
}

export interface HelpinatorLibraryDetail extends HelpinatorLibrary {
  sources: HelpinatorSource[]
  stats: HelpinatorLibraryStats
  embedding_model: string
  index_stale: boolean
}

export interface HelpinatorPageSummary {
  id: string
  source_id: string
  url: string
  title: string
  bytes: number
  fetched_at: string
}

export interface HelpinatorWidget {
  id: string
  name: string
  library_ids: string[]
  default_library_id: string | null
  default_section_key: string | null
  allowed_origins: string[]
  daily_message_cap: number
  enabled: boolean
  // Stored overrides only.
  appearance: Partial<HelpinatorAppearanceForm>
  appearance_defaults: HelpinatorAppearanceForm
  extra_instructions: string
  starter_questions: string[]
  // Own chat model; null follows the org's choice.
  chat_model: string | null
  // The stored model is one the org can no longer use; turns fall back to the
  // org's choice until it is changed.
  chat_model_unavailable: boolean
  created_at: string
  updated_at: string
}

export interface HelpinatorPortfolioOption {
  id: string
  slug: string
  name: string
  sections: { key: string, title: string, description: string }[]
}

export interface HelpinatorConversationSummary {
  id: string
  widget_id: string
  widget_name: string | null
  visitor_email: string | null
  page_url: string | null
  origin: string | null
  user_agent: string | null
  visitor_message_count: number
  inbox_conversation_id: string | null
  handoff_kind: 'visitor' | 'staff' | null
  handed_off_at: string | null
  ended_at: string | null
  created_at: string
  last_message_at: string
  first_question?: string | null
}

export interface HelpinatorTranscriptMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  model: string | null
  created_at: string
  pages_loaded: { ref: string, title: string, url?: string }[]
  searches: string[]
  search_hits: { ref: string, title: string, url?: string }[]
}

export function helpinatorErrorMessage(err: unknown): string {
  const e = err as { data?: { statusMessage?: string, message?: string }, statusMessage?: string, message?: string }
  return e?.data?.statusMessage || e?.data?.message || e?.statusMessage || e?.message || 'Something went wrong.'
}

export function helpinatorFormatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export type HelpinatorListState = 'all' | 'handed_off' | 'with_email' | 'bot_only'

// The conversation-log API filters for a channel (`'all'` or a widget id) and state.
export function helpinatorListFilter(widgetId: string, state: HelpinatorListState): Record<string, string> {
  return {
    ...(widgetId !== 'all' ? { widgetId } : {}),
    ...(state === 'handed_off' ? { handedOff: 'true' } : {}),
    ...(state === 'bot_only' ? { handedOff: 'false' } : {}),
    ...(state === 'with_email' ? { hasEmail: 'true' } : {})
  }
}
