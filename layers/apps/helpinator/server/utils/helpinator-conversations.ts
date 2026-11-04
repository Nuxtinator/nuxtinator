// Conversation + message persistence, the transcript renderer, and the
// visitor's "still need help?" inbox handoff.
import { sql, type Selectable, type Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import { isAppEnabledForCurrentOrg } from '#tenant/server'
import { helpinatorInbox } from '#helpinator/inbox'
import type { HelpinatorPageLoaded, HelpinatorSearchHitLogged } from '../database/schema'
import { helpinatorSameBinding, type HelpinatorWidgetRow } from './helpinator-widgets'
import { helpinatorCurrentScope } from './helpinator-guards'

type Tx = Transaction<Database>

export type HelpinatorConversationRow = Selectable<Database['helpinator_conversations']>
export type HelpinatorMessageRow = Selectable<Database['helpinator_messages']>

export async function helpinatorCreateConversation(tx: Tx, data: {
  widget: HelpinatorWidgetRow
  sessionHash: string
  pageUrl: string | null
  origin: string | null
  userAgent: string | null
}): Promise<HelpinatorConversationRow> {
  if (data.widget.library_ids.length === 0) throw createError({ statusCode: 503, statusMessage: 'This help widget is not available.' })
  return await tx
    .insertInto('helpinator_conversations')
    .values({
      widget_id: data.widget.id,
      library_ids: data.widget.library_ids,
      default_library_id: data.widget.default_library_id,
      session_hash: data.sessionHash,
      page_url: data.pageUrl?.slice(0, 2000) ?? null,
      origin: data.origin,
      user_agent: data.userAgent?.slice(0, 500) ?? null
    })
    .returningAll()
    .executeTakeFirstOrThrow()
}

// A visitor's conversation: the token must match AND belong to this widget, so
// a token minted on widget A is useless on widget B.
export async function helpinatorFindSession(
  tx: Tx,
  widgetId: string,
  sessionHash: string
): Promise<HelpinatorConversationRow | null> {
  const row = await tx
    .selectFrom('helpinator_conversations')
    .selectAll()
    .where('session_hash', '=', sessionHash)
    .where('widget_id', '=', widgetId)
    .executeTakeFirst()
  return row ?? null
}

// Whether a conversation may take another turn on its widget as it is now.
// A widget rebound to other libraries ends the old conversations.
export function helpinatorIsLive(conversation: HelpinatorConversationRow, widget: HelpinatorWidgetRow): boolean {
  return conversation.ended_at === null && helpinatorSameBinding(conversation, widget)
}

export async function helpinatorListMessages(tx: Tx, conversationId: string): Promise<HelpinatorMessageRow[]> {
  return await tx
    .selectFrom('helpinator_messages')
    .selectAll()
    .where('conversation_id', '=', conversationId)
    .orderBy('created_at')
    .orderBy('id')
    .execute()
}

export async function helpinatorInsertMessage(tx: Tx, data: {
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  pagesLoaded?: HelpinatorPageLoaded[]
  searches?: string[]
  searchHits?: HelpinatorSearchHitLogged[]
  model?: string | null
}): Promise<HelpinatorMessageRow> {
  const row = await tx
    .insertInto('helpinator_messages')
    .values({
      conversation_id: data.conversationId,
      role: data.role,
      content: data.content,
      pages_loaded: sql`${JSON.stringify(data.pagesLoaded ?? [])}::text::jsonb`,
      searches: sql`${JSON.stringify(data.searches ?? [])}::text::jsonb`,
      search_hits: sql`${JSON.stringify(data.searchHits ?? [])}::text::jsonb`,
      model: data.model ?? null,
      // clock_timestamp, not now(): both turns of an exchange are inserted in
      // one transaction and must still sort in order.
      created_at: sql`clock_timestamp()`
    })
    .returningAll()
    .executeTakeFirstOrThrow()
  await tx
    .updateTable('helpinator_conversations')
    .set({
      last_message_at: sql`clock_timestamp()`,
      ...(data.role === 'user' ? { visitor_message_count: sql`visitor_message_count + 1` } : {})
    })
    .where('id', '=', data.conversationId)
    .execute()
  return row
}

// Undo helpinatorInsertMessage for a turn that failed.
export async function helpinatorDeleteMessage(tx: Tx, message: HelpinatorMessageRow): Promise<void> {
  await tx.deleteFrom('helpinator_messages').where('id', '=', message.id).execute()
  if (message.role === 'user') {
    await tx
      .updateTable('helpinator_conversations')
      .set({ visitor_message_count: sql`greatest(visitor_message_count - 1, 0)` })
      .where('id', '=', message.conversation_id)
      .execute()
  }
}

// What the widget needs to restore itself (and the admin detail view).
export function helpinatorPublicMessage(m: HelpinatorMessageRow) {
  return { id: m.id, role: m.role, content: m.content, createdAt: m.created_at }
}

// ---------------------------------------------------------------------------
// Transcript

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function label(role: 'user' | 'assistant'): string {
  return role === 'user' ? 'You' : 'Assistant'
}

export function helpinatorTranscriptText(messages: HelpinatorMessageRow[]): string {
  return messages.map(m => `${label(m.role)}:\n${m.content}`).join('\n\n')
}

// Escaped, email-safe HTML. Message text is shown as-is (no Markdown
// rendering) so nothing a visitor or the model wrote can inject markup.
export function helpinatorTranscriptHtml(messages: HelpinatorMessageRow[]): string {
  const rows = messages.map((m) => {
    const body = escapeHtml(m.content).replace(/\n/g, '<br>')
    const bg = m.role === 'user' ? '#eef2ff' : '#f4f4f5'
    return `<div style="margin:0 0 10px;padding:10px 12px;border-radius:8px;background:${bg};">`
      + `<div style="font-size:12px;font-weight:600;color:#52525b;margin-bottom:4px;">${label(m.role)}</div>`
      + `<div style="font-size:14px;line-height:1.5;color:#18181b;">${body}</div></div>`
  })
  return rows.join('\n')
}

// ---------------------------------------------------------------------------
// Handoff to the inbox

export class HelpinatorAlreadyHandedOff extends Error {}

export interface HelpinatorHandoffResult {
  inboxConversationId: string
  // Post-commit side effects (staff notification / auto-ack). Call AFTER the
  // caller's transaction has committed.
  afterCommit: () => Promise<void>
}

// Record a handoff inside the caller's tx: create the inbox conversation with
// the transcript as its first message and link it. At most one handoff per
// conversation (row-locked so two concurrent submits can't both create one).
// Handoff needs the inbox layer on this deployment AND the inbox app on for
// the widget's org (the tx must be scoped to it).
export async function helpinatorHandoffAvailable(tx: Tx): Promise<boolean> {
  return helpinatorInbox.available && await isAppEnabledForCurrentOrg(tx, 'inbox')
}

export async function helpinatorHandOff(tx: Tx, opts: {
  conversationId: string
  widget: HelpinatorWidgetRow
  email: string
  userAgent: string | null
}): Promise<HelpinatorHandoffResult> {
  if (!helpinatorInbox.available) {
    throw createError({ statusCode: 501, statusMessage: 'The inbox is not available on this deployment.' })
  }
  if (!await isAppEnabledForCurrentOrg(tx, 'inbox')) {
    throw createError({ statusCode: 503, statusMessage: 'Handoff is not available for this organization.' })
  }
  const locked = await tx
    .selectFrom('helpinator_conversations')
    .selectAll()
    .where('id', '=', opts.conversationId)
    .forUpdate()
    .executeTakeFirstOrThrow()
  if (locked.inbox_conversation_id) throw new HelpinatorAlreadyHandedOff()

  const messages = await helpinatorListMessages(tx, opts.conversationId)
  if (messages.length === 0) throw createError({ statusCode: 400, statusMessage: 'Nothing to hand off yet.' })

  // A handoff mails an address the visitor typed, and nothing proves the
  // visitor owns it (a verified address only proves SOMEONE there reads the
  // org's mail). So nothing the visitor wrote, or the bot was steered into
  // writing, goes into what that address receives: the subject is the org's
  // widget name (it is also the auto-ack's subject) and the ack carries no
  // transcript.
  const subject = `Help chat: ${opts.widget.name}`.slice(0, 120)
  const header = locked.page_url ? `Help chat from ${locked.page_url}` : `Help chat (${opts.widget.name})`
  const transcriptText = `${header}\n\n${helpinatorTranscriptText(messages)}`
  const transcriptHtml = `<p><strong>${escapeHtml(header)}</strong></p>\n${helpinatorTranscriptHtml(messages)}`

  const record = await helpinatorInbox.recordHandoff(tx, {
    email: opts.email,
    subject,
    transcriptText,
    transcriptHtml,
    assignedUserId: null,
    userAgent: opts.userAgent
  })

  await tx
    .updateTable('helpinator_conversations')
    .set({
      visitor_email: opts.email,
      inbox_conversation_id: record.inboxConversationId,
      handoff_kind: 'visitor',
      handed_off_at: sql`now()`,
      handed_off_by: null
    })
    .where('id', '=', opts.conversationId)
    .execute()

  const scope = await helpinatorCurrentScope(tx)
  // Notify staff, and send the inbox's fixed auto-ack.
  return {
    inboxConversationId: record.inboxConversationId,
    afterCommit: () => helpinatorInbox.afterHandoff(scope, record, { notify: true, ack: true })
  }
}
