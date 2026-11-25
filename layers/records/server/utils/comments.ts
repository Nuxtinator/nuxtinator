// Record comment service. records_comments is its own timeline stream —
// adding a comment writes NO records_activity row; the client merges the
// comment and activity streams by timestamp into one display timeline.
// Display rule: author_label wins when set (system/magic-link writers carry
// their own display name); otherwise the author's user row resolves the name.
// author_id is SET NULL when a user is deleted, so label-less orphans display
// as "Unknown".
//
// Every function takes the caller's tenant transaction — org context (the RLS
// GUC in multi mode) exists only inside it, so nothing here opens connections.
//
// A body is Markdown, written like a rich text field's value: an image is
// `![name](attachment:<file id>)` and a person is the editor's mention node.
// A comment's images are files on its record under the key `comment:<id>`.
// An image uploaded before its comment is posted or saved waits under the
// uploader's draft key; the write moves the ones its text shows onto the
// comment and takes any other image out of the text. `sweepCommentDrafts`
// deletes drafts no comment took within a day.

import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import type { SqlBool, Transaction } from 'kysely'
import { z } from 'zod'
import type { Database } from '#core/server/database/schema'
import { createNotification } from '#core/server/utils/notifications'
import { listOrgScopes, withOrgScope } from '#tenant/server'
import type { TenantContext } from '#tenant/server'
import type { RecordsAttachmentValue } from '#records'
import { addRecordAttachment, listRecordAttachments, type RecordsAttachmentFile } from './attachments'
import { resolveClientNames } from './client-names'
import { getRecordType } from './definition-settings'
import { recordsImageFileIds, recordsMentionedUserIds } from './rich-text'
import { recordsUsersWhoSee } from './share-confirmation'

type Tx = Transaction<Database>

const uuidSchema = z.string().uuid()

const DEFAULT_LIMIT = 30
const MAX_LIMIT = 100
const MAX_BODY_LENGTH = 10000

const IMAGE_RE = /!\[[^\]]*\]\(attachment:([0-9a-f-]{36})\)/gi
// Only these show as images in the browser (see attachments.ts).
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'])
const DRAFT_PREFIX = 'comment-draft:'
const DRAFT_LIFETIME = sql`interval '1 day'`

/** The field key of a comment's images in records_attachments. */
export const commentImageKey = (commentId: string) => `comment:${commentId}`
const commentDraftKey = (userId: string) => `${DRAFT_PREFIX}${userId}`

// ---------------------------------------------------------------------------
// Keyset cursors — shared by the comment and activity streams
// ---------------------------------------------------------------------------

/** Decoded pagination position over (created_at, id), newest-first. */
export interface RecordsTimelineCursor {
  createdAt: string
  id: string
}

export interface RecordsTimelineListOpts {
  /** Page size, 1..100 (default 30). */
  limit?: number
  /** Cursor from a previous page's nextCursor — strictly older rows come back. */
  before?: string
}

// `<created_at ISO>_<uuid>` — neither part contains an underscore.
export function encodeTimelineCursor(createdAt: Date, id: string): string {
  return `${createdAt.toISOString()}_${id}`
}

export function decodeTimelineCursor(raw: string): RecordsTimelineCursor {
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

export interface RecordsComment {
  id: string
  authorId: string | null
  authorName: string
  /** The author's avatar image; null for a labelled author or one without an image. */
  authorAvatarUrl: string | null
  body: string
  createdAt: Date
  editedAt: Date | null
  /** Name of the connected app the comment came through; null for the web. */
  viaClient: string | null
  /** The files the body shows as images, with their current links. */
  images: RecordsAttachmentValue[]
}

export interface RecordsCommentPage {
  items: RecordsComment[]
  nextCursor: string | null
}

export async function listComments(
  tx: Tx,
  recordId: string,
  opts: RecordsTimelineListOpts = {}
): Promise<RecordsCommentPage> {
  if (!uuidSchema.safeParse(recordId).success) {
    throw createError({ statusCode: 404, statusMessage: 'Record not found.' })
  }
  const limit = clampTimelineLimit(opts.limit)
  let qb = tx
    .selectFrom('records_comments as c')
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
      'u.email as user_email',
      'u.avatar as user_avatar'
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
  const files = (await listRecordAttachments(tx, [recordId], page.map(r => commentImageKey(r.id)))).get(recordId)
  const items = page.map(r => ({
    id: r.id,
    authorId: r.author_id,
    authorName: r.author_label ?? r.user_name ?? r.user_email ?? 'Unknown',
    authorAvatarUrl: r.author_label ? null : r.user_avatar || null,
    body: r.body,
    createdAt: r.created_at,
    editedAt: r.edited_at,
    viaClient: r.client_id ? clients.get(r.client_id) ?? r.client_id : null,
    images: files?.get(commentImageKey(r.id)) ?? []
  }))
  const last = rows.length > limit ? page[page.length - 1]! : null
  return { items, nextCursor: last ? encodeTimelineCursor(last.created_at, last.id) : null }
}

/** A comment's record linkage — routes resolve type-scoped permissions from it. */
export interface RecordsCommentRef {
  commentId: string
  recordId: string
  recordType: string
  authorId: string | null
}

export async function getCommentRecord(tx: Tx, commentId: string): Promise<RecordsCommentRef | null> {
  if (!uuidSchema.safeParse(commentId).success) return null
  const row = await tx
    .selectFrom('records_comments as c')
    .innerJoin('records_entries as r', 'r.id', 'c.record_id')
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

async function resolveAuthor(
  tx: Tx,
  row: { author_id: string | null, author_label: string | null }
): Promise<{ authorName: string, authorAvatarUrl: string | null }> {
  if (row.author_label) return { authorName: row.author_label, authorAvatarUrl: null }
  if (!row.author_id) return { authorName: 'Unknown', authorAvatarUrl: null }
  const user = await tx
    .selectFrom('users')
    .select(['display_name', 'email', 'avatar'])
    .where('id', '=', row.author_id)
    .executeTakeFirst()
  return {
    authorName: user?.display_name ?? user?.email ?? 'Unknown',
    authorAvatarUrl: user?.avatar || null
  }
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
    .selectFrom('records_comments')
    .selectAll()
    .where('id', '=', commentId)
    .executeTakeFirst()
  if (!row) {
    throw createError({ statusCode: 404, statusMessage: 'Comment not found.' })
  }
  return row
}

async function commentImages(tx: Tx, recordId: string, commentId: string): Promise<RecordsAttachmentValue[]> {
  const key = commentImageKey(commentId)
  return (await listRecordAttachments(tx, [recordId], [key])).get(recordId)?.get(key) ?? []
}

// Fits the comment's files to `body`, its new text: an image already on the
// comment stays, one of the writer's drafts moves onto it, and any other
// image is taken out of the text. A file the comment no longer shows is
// deleted. Returns the text to store.
async function settleCommentImages(tx: Tx, ctx: TenantContext, recordId: string, commentId: string, body: string): Promise<string> {
  const own = commentImageKey(commentId)
  const draft = commentDraftKey(ctx.userId)
  const shown = new Set(recordsImageFileIds(body))
  const files = await tx
    .selectFrom('records_attachments')
    .select(['id', 'field_key'])
    .where('record_id', '=', recordId)
    .where('field_key', 'in', [own, draft])
    .execute()
  const kept = new Set(files.filter(f => shown.has(f.id.toLowerCase())).map(f => f.id.toLowerCase()))
  const claimed = files.filter(f => f.field_key === draft && kept.has(f.id.toLowerCase())).map(f => f.id)
  if (claimed.length > 0) {
    await tx.updateTable('records_attachments').set({ field_key: own }).where('id', 'in', claimed).execute()
  }
  const dropped = files.filter(f => f.field_key === own && !kept.has(f.id.toLowerCase())).map(f => f.id)
  if (dropped.length > 0) {
    await tx.deleteFrom('records_attachments').where('id', 'in', dropped).execute()
  }
  return body.replace(IMAGE_RE, (whole, id: string) => kept.has(id.toLowerCase()) ? whole : '')
}

// Tells the people a comment newly mentions, in the app and by email, if they
// can open the record, as a mention in a rich text field does.
async function notifyCommentMentions(tx: Tx, ctx: TenantContext, recordId: string, before: string | null, after: string): Promise<void> {
  const had = new Set(recordsMentionedUserIds(before))
  const added = recordsMentionedUserIds(after).filter(id => !had.has(id) && id !== ctx.userId)
  if (added.length === 0) return
  const record = await tx
    .selectFrom('records_entries')
    .select(['record_type', 'name'])
    .where('id', '=', recordId)
    .executeTakeFirst()
  const type = record ? await getRecordType(tx, record.record_type) : null
  if (!record || !type) return
  const recipients = await recordsUsersWhoSee(tx, ctx, type.key, recordId, added)
  if (recipients.length === 0) return
  const actor = await tx.selectFrom('users').select('display_name').where('id', '=', ctx.userId).executeTakeFirst()
  const noun = type.labelSingular.toLowerCase()
  const article = /^[aeiou]/.test(noun) ? 'an' : 'a'
  await createNotification(tx, recipients.map(userId => ({
    userId,
    appId: type.manifest?.app ?? 'records',
    title: `${actor?.display_name || 'Someone'} mentioned you in a comment on ${article} ${noun}`,
    body: record.name,
    icon: 'i-lucide-at-sign',
    link: `/records/${type.key}/${recordId}`,
    actorId: ctx.userId,
    email: 'immediate' as const
  })))
}

/**
 * Uploads an image for a comment the caller is writing on the record. It
 * waits as the caller's draft until a comment shows it. The caller has
 * already checked that the caller may comment on the record.
 */
export async function addCommentImage(
  tx: Tx,
  ctx: TenantContext,
  recordId: string,
  file: RecordsAttachmentFile
): Promise<RecordsAttachmentValue> {
  if (!IMAGE_TYPES.has(file.mime)) {
    throw createError({ statusCode: 400, statusMessage: 'A comment can show PNG, JPEG, GIF, WebP or AVIF images only.' })
  }
  return await addRecordAttachment(tx, ctx, recordId, commentDraftKey(ctx.userId), file)
}

/** Deletes comment images no comment took within a day of upload, one org at a time. */
export async function sweepCommentDrafts(): Promise<void> {
  for (const orgId of await listOrgScopes()) {
    await withOrgScope(orgId, tx => tx
      .deleteFrom('records_attachments')
      .where('field_key', 'like', `${DRAFT_PREFIX}%`)
      .where('created_at', '<', sql<Date>`now() - ${DRAFT_LIFETIME}`)
      .execute())
  }
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
): Promise<RecordsComment> {
  if (!uuidSchema.safeParse(recordId).success) {
    throw createError({ statusCode: 404, statusMessage: 'Record not found.' })
  }
  const id = randomUUID()
  const body = requireCommentBody(await settleCommentImages(tx, ctx, recordId, id, requireCommentBody(opts.body)))
  const row = await tx
    .insertInto('records_comments')
    .values({
      id,
      record_id: recordId,
      author_id: ctx.userId,
      author_label: opts.authorLabel ?? null,
      body,
      client_id: ctx.clientId ?? null
    })
    .returningAll()
    .executeTakeFirstOrThrow()
  await notifyCommentMentions(tx, ctx, recordId, null, row.body)
  return {
    id: row.id,
    authorId: row.author_id,
    ...await resolveAuthor(tx, row),
    body: row.body,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    viaClient: await viaClientOf(tx, row.client_id),
    images: await commentImages(tx, recordId, row.id)
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
): Promise<RecordsComment> {
  requireCommentBody(body)
  const existing = await loadComment(tx, commentId)
  if (existing.author_id !== ctx.userId && !opts.canModerate) {
    throw createError({ statusCode: 403, statusMessage: 'You can only edit your own comments.' })
  }
  const trimmed = requireCommentBody(await settleCommentImages(tx, ctx, existing.record_id, commentId, body.trim()))
  const row = await tx
    .updateTable('records_comments')
    .set({ body: trimmed, edited_at: sql`now()`, updated_at: sql`now()` })
    .where('id', '=', commentId)
    .returningAll()
    .executeTakeFirstOrThrow()
  await notifyCommentMentions(tx, ctx, row.record_id, existing.body, row.body)
  return {
    id: row.id,
    authorId: row.author_id,
    ...await resolveAuthor(tx, row),
    body: row.body,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    viaClient: await viaClientOf(tx, row.client_id),
    images: await commentImages(tx, row.record_id, row.id)
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
    .deleteFrom('records_attachments')
    .where('record_id', '=', existing.record_id)
    .where('field_key', '=', commentImageKey(commentId))
    .execute()
  await tx
    .deleteFrom('records_comments')
    .where('id', '=', commentId)
    .execute()
}
