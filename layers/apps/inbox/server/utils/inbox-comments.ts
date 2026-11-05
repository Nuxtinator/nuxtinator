// Internal notes on a conversation — plain text, keyset-paginated newest-first.
// Mirrors the records_comments service (same cursor grammar, author-label-
// wins, own-or-moderate moderation, edited_at marker). Every function takes the
// caller's org tx so RLS scopes rows. System notes (author_id null) are never
// editable.
import { sql } from 'kysely'
import { z } from 'zod'
import type { SqlBool, Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'

type Tx = Transaction<Database>

const DEFAULT_LIMIT = 30
const MAX_LIMIT = 100
const MAX_BODY_LENGTH = 10_000
const uuidSchema = z.string().uuid()

export interface InboxCommentCursor { createdAt: string, id: string }
export interface InboxCommentListOpts { limit?: number, before?: string }

// Cursor string: `${createdAt.toISOString()}_${id}` — neither part contains '_'.
export function encodeInboxCommentCursor(createdAt: Date, id: string): string {
  return `${createdAt.toISOString()}_${id}`
}
export function decodeInboxCommentCursor(raw: string): InboxCommentCursor {
  const at = raw.indexOf('_')
  const createdAt = at === -1 ? '' : raw.slice(0, at)
  const id = at === -1 ? '' : raw.slice(at + 1)
  if (!createdAt || Number.isNaN(Date.parse(createdAt)) || !uuidSchema.safeParse(id).success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid cursor' })
  }
  return { createdAt, id }
}
export function clampInboxCommentLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
}

export interface InboxComment {
  id: string
  authorId: string | null
  authorName: string
  body: string
  createdAt: Date
  editedAt: Date | null
}
export interface InboxCommentPage { items: InboxComment[], nextCursor: string | null }

async function resolveUserName(tx: Tx, userId: string | null): Promise<string> {
  if (!userId) return 'Unknown'
  const u = await tx.selectFrom('users').select(['display_name', 'email']).where('id', '=', userId).executeTakeFirst()
  return u?.display_name ?? u?.email ?? 'Unknown'
}

function requireBody(body: string): string {
  const trimmed = body.trim()
  if (!trimmed) throw createError({ statusCode: 400, statusMessage: 'Note cannot be empty' })
  if (trimmed.length > MAX_BODY_LENGTH) throw createError({ statusCode: 400, statusMessage: 'Note is too long' })
  return trimmed
}

export async function inboxListComments(
  tx: Tx,
  conversationId: string,
  opts: InboxCommentListOpts = {}
): Promise<InboxCommentPage> {
  const limit = clampInboxCommentLimit(opts.limit)
  let q = tx
    .selectFrom('inbox_comments as c')
    .leftJoin('users as u', 'u.id', 'c.author_id')
    .select([
      'c.id as id', 'c.author_id as author_id', 'c.author_label as author_label',
      'c.body as body', 'c.created_at as created_at', 'c.edited_at as edited_at',
      'u.display_name as user_name', 'u.email as user_email'
    ])
    .where('c.conversation_id', '=', conversationId)
  if (opts.before) {
    const cur = decodeInboxCommentCursor(opts.before)
    q = q.where(sql<SqlBool>`(c.created_at, c.id) < (${cur.createdAt}::timestamptz, ${cur.id}::uuid)`)
  }
  const rows = await q.orderBy('c.created_at', 'desc').orderBy('c.id', 'desc').limit(limit + 1).execute()
  const page = rows.slice(0, limit)
  const items: InboxComment[] = page.map(r => ({
    id: r.id,
    authorId: r.author_id,
    authorName: r.author_label ?? r.user_name ?? r.user_email ?? 'Unknown',
    body: r.body,
    createdAt: r.created_at,
    editedAt: r.edited_at
  }))
  const last = page[page.length - 1]
  const nextCursor = rows.length > limit && last ? encodeInboxCommentCursor(last.created_at, last.id) : null
  return { items, nextCursor }
}

export async function inboxAddComment(
  tx: Tx,
  conversationId: string,
  authorId: string,
  body: string
): Promise<InboxComment> {
  const trimmed = requireBody(body)
  const row = await tx
    .insertInto('inbox_comments')
    .values({ conversation_id: conversationId, author_id: authorId, body: trimmed })
    .returningAll()
    .executeTakeFirstOrThrow()
  return {
    id: row.id,
    authorId: row.author_id,
    authorName: row.author_label ?? await resolveUserName(tx, row.author_id),
    body: row.body,
    createdAt: row.created_at,
    editedAt: row.edited_at
  }
}

async function loadComment(tx: Tx, commentId: string) {
  if (!uuidSchema.safeParse(commentId).success) {
    throw createError({ statusCode: 404, statusMessage: 'Note not found' })
  }
  const row = await tx.selectFrom('inbox_comments').selectAll().where('id', '=', commentId).executeTakeFirst()
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Note not found' })
  return row
}

// Own-or-moderate guard shared by edit/delete. A system note (null author) is
// never editable, even by a moderator.
function assertCanModerate(authorId: string | null, userId: string, canModerate: boolean): void {
  if (authorId === null) {
    throw createError({ statusCode: 403, statusMessage: 'System notes cannot be modified' })
  }
  if (authorId !== userId && !canModerate) {
    throw createError({ statusCode: 403, statusMessage: 'You can only edit your own notes' })
  }
}

export async function inboxUpdateComment(
  tx: Tx,
  commentId: string,
  userId: string,
  body: string,
  canModerate: boolean
): Promise<InboxComment> {
  const existing = await loadComment(tx, commentId)
  assertCanModerate(existing.author_id, userId, canModerate)
  const trimmed = requireBody(body)
  const row = await tx
    .updateTable('inbox_comments')
    .set({ body: trimmed, edited_at: sql`now()`, updated_at: sql`now()` })
    .where('id', '=', commentId)
    .returningAll()
    .executeTakeFirstOrThrow()
  return {
    id: row.id,
    authorId: row.author_id,
    authorName: row.author_label ?? await resolveUserName(tx, row.author_id),
    body: row.body,
    createdAt: row.created_at,
    editedAt: row.edited_at
  }
}

export async function inboxDeleteComment(
  tx: Tx,
  commentId: string,
  userId: string,
  canModerate: boolean
): Promise<void> {
  const existing = await loadComment(tx, commentId)
  assertCanModerate(existing.author_id, userId, canModerate)
  await tx.deleteFrom('inbox_comments').where('id', '=', commentId).execute()
}
