// Record comment service. crm_record_comments is its own timeline stream —
// adding a comment writes NO crm_record_activity row; the client merges the
// comment and activity streams by timestamp into one display timeline.
// Display rule: author_label wins when set (system/magic-link writers carry
// their own display name); otherwise the author's user row resolves the name.
// author_id is SET NULL when a user is deleted, so label-less orphans display
// as "Unknown".
//
// Every function takes the caller's tenant transaction — org context (the RLS
// GUC in multi mode) exists only inside it, so nothing here opens connections.

import { sql } from 'kysely'
import type { SqlBool, Transaction } from 'kysely'
import { z } from 'zod'
import type { Database } from '#core/server/database/schema'
import type { TenantContext } from '#tenant/server'
import { resolveClientNames } from './client-names'

type Tx = Transaction<Database>

const uuidSchema = z.string().uuid()

const DEFAULT_LIMIT = 30
const MAX_LIMIT = 100
const MAX_BODY_LENGTH = 10000

// ---------------------------------------------------------------------------
// Keyset cursors — shared by the comment and activity streams
// ---------------------------------------------------------------------------

/** Decoded pagination position over (created_at, id), newest-first. */
export interface CrmTimelineCursor {
  createdAt: string
  id: string
}

export interface CrmTimelineListOpts {
  /** Page size, 1..100 (default 30). */
  limit?: number
  /** Cursor from a previous page's nextCursor — strictly older rows come back. */
  before?: string
}

// `<created_at ISO>_<uuid>` — neither part contains an underscore.
export function encodeTimelineCursor(createdAt: Date, id: string): string {
  return `${createdAt.toISOString()}_${id}`
}

export function decodeTimelineCursor(raw: string): CrmTimelineCursor {
  const sep = raw.indexOf('_')
  const createdAt = sep > 0 ? raw.slice(0, sep) : ''
  const id = sep > 0 ? raw.slice(sep + 1) : ''
  if (Number.isNaN(Date.parse(createdAt)) || !uuidSchema.safeParse(id).success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid cursor.' })
  }
  return { createdAt, id }
}

export function clampTimelineLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface CrmComment {
  id: string
  authorId: string | null
  authorName: string
  body: string
  createdAt: Date
  editedAt: Date | null
  /** Name of the connected app the comment came through; null for the web. */
  viaClient: string | null
}

export interface CrmCommentPage {
  items: CrmComment[]
  nextCursor: string | null
}

export async function listComments(
  tx: Tx,
  recordId: string,
  opts: CrmTimelineListOpts = {}
): Promise<CrmCommentPage> {
  if (!uuidSchema.safeParse(recordId).success) {
    throw createError({ statusCode: 404, statusMessage: 'Record not found.' })
  }
  const limit = clampTimelineLimit(opts.limit)
  let qb = tx
    .selectFrom('crm_record_comments as c')
    .leftJoin('users as u', 'u.id', 'c.author_id')
    .select([
      'c.id as id',
      'c.author_id as author_id',
      'c.author_label as author_label',
      'c.body as body',
      'c.created_at as created_at',
      'c.edited_at as edited_at',
      'c.client_id as client_id',
      'u.display_name as user_name',
      'u.email as user_email'
    ])
    .where('c.record_id', '=', recordId)
  if (opts.before) {
    const cursor = decodeTimelineCursor(opts.before)
    qb = qb.where(sql<SqlBool>`(c.created_at, c.id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`)
  }
  // limit + 1: the extra row only signals that another page exists.
  const rows = await qb
    .orderBy('c.created_at', 'desc')
    .orderBy('c.id', 'desc')
    .limit(limit + 1)
    .execute()
  const page = rows.slice(0, limit)
  const clients = await resolveClientNames(tx, page.map(r => r.client_id))
  const items = page.map(r => ({
    id: r.id,
    authorId: r.author_id,
    authorName: r.author_label ?? r.user_name ?? r.user_email ?? 'Unknown',
    body: r.body,
    createdAt: r.created_at,
    editedAt: r.edited_at,
    viaClient: r.client_id ? clients.get(r.client_id) ?? r.client_id : null
  }))
  const last = rows.length > limit ? page[page.length - 1]! : null
  return { items, nextCursor: last ? encodeTimelineCursor(last.created_at, last.id) : null }
}

/** A comment's record linkage — routes resolve type-scoped permissions from it. */
export interface CrmCommentRef {
  commentId: string
  recordId: string
  recordType: string
  authorId: string | null
}

export async function getCommentRecord(tx: Tx, commentId: string): Promise<CrmCommentRef | null> {
  if (!uuidSchema.safeParse(commentId).success) return null
  const row = await tx
    .selectFrom('crm_record_comments as c')
    .innerJoin('crm_records as r', 'r.id', 'c.record_id')
    .select([
      'c.id as comment_id',
      'c.author_id as author_id',
      'r.id as record_id',
      'r.record_type as record_type'
    ])
    .where('c.id', '=', commentId)
    .executeTakeFirst()
  if (!row) return null
  return {
    commentId: row.comment_id,
    recordId: row.record_id,
    recordType: row.record_type,
    authorId: row.author_id
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function requireCommentBody(body: string): string {
  const trimmed = body.trim()
  if (trimmed.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'Comment body cannot be empty.' })
  }
  if (trimmed.length > MAX_BODY_LENGTH) {
    throw createError({ statusCode: 400, statusMessage: `Comment body is too long (max ${MAX_BODY_LENGTH} characters).` })
  }
  return trimmed
}

async function resolveUserName(tx: Tx, userId: string | null): Promise<string> {
  if (!userId) return 'Unknown'
  const user = await tx
    .selectFrom('users')
    .select(['display_name', 'email'])
    .where('id', '=', userId)
    .executeTakeFirst()
  return user?.display_name ?? user?.email ?? 'Unknown'
}

async function viaClientOf(tx: Tx, clientId: string | null): Promise<string | null> {
  if (!clientId) return null
  return (await resolveClientNames(tx, [clientId])).get(clientId) ?? clientId
}

async function loadComment(tx: Tx, commentId: string) {
  if (!uuidSchema.safeParse(commentId).success) {
    throw createError({ statusCode: 404, statusMessage: 'Comment not found.' })
  }
  const row = await tx
    .selectFrom('crm_record_comments')
    .selectAll()
    .where('id', '=', commentId)
    .executeTakeFirst()
  if (!row) {
    throw createError({ statusCode: 404, statusMessage: 'Comment not found.' })
  }
  return row
}

export interface AddCommentOpts {
  body: string
  /** Display name for system/magic-link authors; wins over user-name resolution. */
  authorLabel?: string
}

export async function addComment(
  tx: Tx,
  ctx: TenantContext,
  recordId: string,
  opts: AddCommentOpts
): Promise<CrmComment> {
  if (!uuidSchema.safeParse(recordId).success) {
    throw createError({ statusCode: 404, statusMessage: 'Record not found.' })
  }
  const body = requireCommentBody(opts.body)
  const row = await tx
    .insertInto('crm_record_comments')
    .values({
      record_id: recordId,
      author_id: ctx.userId,
      author_label: opts.authorLabel ?? null,
      body,
      client_id: ctx.clientId ?? null
    })
    .returningAll()
    .executeTakeFirstOrThrow()
  return {
    id: row.id,
    authorId: row.author_id,
    authorName: row.author_label ?? await resolveUserName(tx, row.author_id),
    body: row.body,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    viaClient: await viaClientOf(tx, row.client_id)
  }
}

export interface CommentModerationOpts {
  /**
   * Whether the caller may act on other users' comments. Routes derive this
   * from the record type's delete permission (delete perm = moderator).
   */
  canModerate: boolean
}

export async function updateComment(
  tx: Tx,
  ctx: TenantContext,
  commentId: string,
  body: string,
  opts: CommentModerationOpts
): Promise<CrmComment> {
  const trimmed = requireCommentBody(body)
  const existing = await loadComment(tx, commentId)
  if (existing.author_id !== ctx.userId && !opts.canModerate) {
    throw createError({ statusCode: 403, statusMessage: 'You can only edit your own comments.' })
  }
  const row = await tx
    .updateTable('crm_record_comments')
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
    editedAt: row.edited_at,
    viaClient: await viaClientOf(tx, row.client_id)
  }
}

export async function deleteComment(
  tx: Tx,
  ctx: TenantContext,
  commentId: string,
  opts: CommentModerationOpts
): Promise<void> {
  const existing = await loadComment(tx, commentId)
  if (existing.author_id !== ctx.userId && !opts.canModerate) {
    throw createError({ statusCode: 403, statusMessage: 'You can only delete your own comments.' })
  }
  await tx
    .deleteFrom('crm_record_comments')
    .where('id', '=', commentId)
    .execute()
}
