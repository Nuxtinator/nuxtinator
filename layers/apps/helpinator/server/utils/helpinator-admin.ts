// Admin-side read models: the widget as the form edits it, and the read-only
// conversation log.
import { sql, type Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import { HELPINATOR_DEFAULT_APPEARANCE, HELPINATOR_UUID_RE, helpinatorAppearanceOverrides, type HelpinatorWidgetRow } from './helpinator-widgets'
import type { HelpinatorConversationRow } from './helpinator-conversations'
import type { HelpinatorLibraryRow, HelpinatorSourceRow } from './helpinator-libraries'

type Tx = Transaction<Database>

export function helpinatorAdminWidget(w: HelpinatorWidgetRow) {
  return {
    id: w.id,
    name: w.name,
    library_ids: w.library_ids,
    default_library_id: w.default_library_id,
    default_section_key: w.default_section_key,
    allowed_origins: w.allowed_origins,
    daily_message_cap: w.daily_message_cap,
    enabled: w.enabled,
    // Overrides only; the form layers them on `appearance_defaults`.
    appearance: helpinatorAppearanceOverrides(w.appearance),
    appearance_defaults: HELPINATOR_DEFAULT_APPEARANCE,
    extra_instructions: w.extra_instructions,
    starter_questions: w.starter_questions,
    created_at: w.created_at,
    updated_at: w.updated_at
  }
}

export function helpinatorAdminLibrary(l: HelpinatorLibraryRow) {
  return {
    id: l.id,
    name: l.name,
    kind: l.kind,
    portfolio_id: l.portfolio_id,
    description: l.description,
    created_at: l.created_at,
    updated_at: l.updated_at
  }
}

// The run token stays server-side.
export function helpinatorAdminSource(s: HelpinatorSourceRow) {
  return {
    id: s.id,
    library_id: s.library_id,
    url: s.url,
    restrict_to_path: s.restrict_to_path,
    max_pages: s.max_pages,
    max_page_mb: s.max_page_mb,
    max_depth: s.max_depth,
    status: s.status,
    run_started_at: s.run_started_at,
    page_count: s.page_count,
    bytes: s.bytes,
    run_total: s.run_total,
    run_done: s.run_done,
    last_synced_at: s.last_synced_at,
    last_error: s.last_error,
    created_at: s.created_at
  }
}

export function helpinatorAdminConversation(c: HelpinatorConversationRow & { widget_name?: string | null }) {
  return {
    id: c.id,
    widget_id: c.widget_id,
    widget_name: c.widget_name ?? null,
    visitor_email: c.visitor_email,
    page_url: c.page_url,
    origin: c.origin,
    user_agent: c.user_agent,
    visitor_message_count: c.visitor_message_count,
    inbox_conversation_id: c.inbox_conversation_id,
    handoff_kind: c.handoff_kind,
    handed_off_at: c.handed_off_at,
    ended_at: c.ended_at,
    created_at: c.created_at,
    last_message_at: c.last_message_at
  }
}

export interface HelpinatorConversationFilter {
  widgetId?: string
  handedOff?: boolean
  hasEmail?: boolean
  limit: number
  offset: number
}

export async function helpinatorListConversations(tx: Tx, f: HelpinatorConversationFilter) {
  let q = tx
    .selectFrom('helpinator_conversations as c')
    .innerJoin('helpinator_widgets as w', 'w.id', 'c.widget_id')
    .selectAll('c')
    .select('w.name as widget_name')
    .select(sql<string | null>`(
      select m.content from helpinator_messages m
      where m.conversation_id = c.id and m.role = 'user'
      order by m.created_at asc limit 1
    )`.as('first_question'))
  if (f.widgetId && HELPINATOR_UUID_RE.test(f.widgetId)) q = q.where('c.widget_id', '=', f.widgetId)
  if (f.handedOff === true) q = q.where('c.inbox_conversation_id', 'is not', null)
  if (f.handedOff === false) q = q.where('c.inbox_conversation_id', 'is', null)
  if (f.hasEmail === true) q = q.where('c.visitor_email', 'is not', null)
  const rows = await q
    .orderBy('c.last_message_at', 'desc')
    .limit(f.limit + 1)
    .offset(f.offset)
    .execute()
  const hasMore = rows.length > f.limit
  return {
    conversations: rows.slice(0, f.limit).map(r => ({
      ...helpinatorAdminConversation(r),
      first_question: r.first_question ? r.first_question.slice(0, 200) : null
    })),
    hasMore
  }
}

export async function helpinatorGetConversationOr404(tx: Tx, id: string) {
  if (!HELPINATOR_UUID_RE.test(id)) throw createError({ statusCode: 404, statusMessage: 'Conversation not found' })
  const row = await tx
    .selectFrom('helpinator_conversations as c')
    .innerJoin('helpinator_widgets as w', 'w.id', 'c.widget_id')
    .selectAll('c')
    .select('w.name as widget_name')
    .where('c.id', '=', id)
    .executeTakeFirst()
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Conversation not found' })
  return row
}
