// Attachments fields: files uploaded onto a record's field. Rows live in
// records_attachments (one per file, ordered by sort_order); the bytes live
// in private object storage. Files arrive one upload at a time through
// `addRecordAttachment` (the attachments route) or straight to storage
// through `beginRecordAttachmentUpload` / `completeRecordAttachmentUpload`
// (the MCP tools), or as copies of another record's files
// (`copyRecordAttachments`), never through a field patch; a patch can only
// reorder or remove them. Deleting a row — directly or with its record —
// queues its object in records_attachment_trash (a trigger), and
// `sweepAttachmentTrash` deletes queued objects from storage. A fresh upload
// is queued too, outside the request's transaction, and taken off the queue
// inside it: if the transaction never commits, the object is still swept.
//
// Other layers keep files for their own per-record fields here under a field
// key they namespace (the views layer uses `views:<viewId>:<fieldKey>`), using
// the same add / list / remove functions.

import { randomBytes } from 'node:crypto'
import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { TenantContext } from '#tenant/server'
import { db } from '#core/server/utils/database'
import { copyS3Object, deleteFromS3, generateSignedUrl, presignedPutUrl, statS3Object, uploadToS3, validateFileSize } from '#core/server/utils/storage'
import type { RecordsAttachmentValue } from '#records'
import type { RecordsListPatch } from './records-registry'

type Tx = Transaction<Database>

/** Largest file an attachments field accepts, in MB. */
export const RECORDS_ATTACHMENT_MAX_MB = 25
/** Most files one attachments field holds. */
export const RECORDS_ATTACHMENTS_PER_FIELD = 50
/** How long an upload URL from `beginRecordAttachmentUpload` takes the file. */
export const RECORDS_UPLOAD_URL_TTL_SECONDS = 60 * 60

// The keys `beginRecordAttachmentUpload` hands out.
const UPLOAD_KEY_RE = /^records\/[0-9a-f]{32}\.[a-z0-9]{1,16}$/

// Links are signed from the start of a six-hour window and last a day, so a
// card's image URL stays the same between polls (browsers cache it) and is
// always good for at least eighteen more hours.
const URL_WINDOW_MS = 6 * 60 * 60 * 1000
const URL_EXPIRY_SECONDS = 24 * 60 * 60

// Queued keys wait this long before the sweep deletes them, so an upload whose
// transaction is still open isn't swept out from under it.
const TRASH_GRACE = sql`interval '1 hour'`

// Only these open in the browser; anything else (HTML, SVG, scripts) downloads,
// served as a plain byte stream so it can't run on the storage domain.
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'])

export interface RecordsAttachmentFile {
  data: Buffer
  filename: string
  mime: string
}

export interface RecordsAttachmentUpload {
  key: string
  uploadUrl: string
  expiresAt: Date
}

async function signedUrl(storageKey: string, filename: string, mime: string): Promise<string> {
  const windowStart = new Date(Math.floor(Date.now() / URL_WINDOW_MS) * URL_WINDOW_MS)
  const inline = INLINE_TYPES.has(mime)
  return await generateSignedUrl(storageKey, URL_EXPIRY_SECONDS, {
    'response-content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'response-content-type': inline ? mime : 'application/octet-stream'
  }, windowStart)
}

interface AttachmentRow {
  id: string
  record_id: string
  field_key: string
  storage_key: string
  filename: string
  mime: string
  size_bytes: string
}

async function toValue(row: AttachmentRow): Promise<RecordsAttachmentValue> {
  return {
    id: row.id,
    name: row.filename,
    mime: row.mime,
    size: Number(row.size_bytes),
    url: await signedUrl(row.storage_key, row.filename, row.mime)
  }
}

/** The files on `fieldKeys` of each record, in order: record id → field key → files. */
export async function listRecordAttachments(
  tx: Tx,
  recordIds: string[],
  fieldKeys: string[]
): Promise<Map<string, Map<string, RecordsAttachmentValue[]>>> {
  const out = new Map<string, Map<string, RecordsAttachmentValue[]>>()
  if (recordIds.length === 0 || fieldKeys.length === 0) return out
  const rows = await tx
    .selectFrom('records_attachments')
    .select(['id', 'record_id', 'field_key', 'storage_key', 'filename', 'mime', 'size_bytes'])
    .where('record_id', 'in', recordIds)
    .where('field_key', 'in', fieldKeys)
    .orderBy('sort_order', 'asc')
    .orderBy('created_at', 'asc')
    .execute()
  for (const row of rows) {
    let byField = out.get(row.record_id)
    if (!byField) {
      byField = new Map()
      out.set(row.record_id, byField)
    }
    const list = byField.get(row.field_key) ?? []
    list.push(await toValue(row))
    byField.set(row.field_key, list)
  }
  return out
}

/**
 * Uploads a file and puts it last on the record's field. The caller has
 * already checked that the caller may change the record (or, for another
 * layer's field, whatever that layer requires).
 */
export async function addRecordAttachment(
  tx: Tx,
  ctx: TenantContext,
  recordId: string,
  fieldKey: string,
  file: RecordsAttachmentFile
): Promise<RecordsAttachmentValue> {
  assertAttachmentSize(file.data.byteLength)
  const sortOrder = await nextSortOrder(tx, recordId, fieldKey)
  const uploaded = await uploadToS3(file.data, file.filename, file.mime, 'private', 'records')
  await db.insertInto('records_attachment_trash').values({ storage_key: uploaded.key }).execute()
  await tx.deleteFrom('records_attachment_trash').where('storage_key', '=', uploaded.key).execute()
  return await insertAttachment(tx, ctx, recordId, fieldKey, {
    storageKey: uploaded.key,
    filename: file.filename,
    mime: file.mime,
    size: file.data.byteLength,
    sortOrder
  })
}

/**
 * Starts an upload the client sends straight to storage: checks the size and
 * that the field has room, and returns a key with a presigned PUT URL for it.
 * The key is queued for the sweep with the URL's expiry as its time, so a
 * file never finished with `completeRecordAttachmentUpload` is swept. The
 * caller has already checked that the caller may change the record.
 */
export async function beginRecordAttachmentUpload(
  tx: Tx,
  recordId: string,
  fieldKey: string,
  file: { filename: string, mime: string, size: number }
): Promise<RecordsAttachmentUpload> {
  assertAttachmentSize(file.size)
  await nextSortOrder(tx, recordId, fieldKey)
  const dot = file.filename.lastIndexOf('.')
  const ext = dot >= 0 ? file.filename.slice(dot + 1).toLowerCase() : ''
  const key = `records/${randomBytes(16).toString('hex')}.${/^[a-z0-9]{1,16}$/.test(ext) ? ext : 'bin'}`
  const expiresAt = new Date(Date.now() + RECORDS_UPLOAD_URL_TTL_SECONDS * 1000)
  const uploadUrl = await presignedPutUrl(key, file.mime, RECORDS_UPLOAD_URL_TTL_SECONDS)
  await db.insertInto('records_attachment_trash').values({ storage_key: key, deleted_at: expiresAt }).execute()
  return { key, uploadUrl, expiresAt }
}

/**
 * Puts a file sent to a `beginRecordAttachmentUpload` URL last on the
 * record's field, typed by the Content-Type it was stored with, and takes its
 * key off the sweep queue. Refuses a key that wasn't handed out, has expired
 * or was already used, and one with nothing stored under it yet. The caller
 * has already checked that the caller may change the record.
 */
export async function completeRecordAttachmentUpload(
  tx: Tx,
  ctx: TenantContext,
  recordId: string,
  fieldKey: string,
  upload: { key: string, filename: string }
): Promise<RecordsAttachmentValue> {
  // A deleted file's key is queued with the time it was deleted, so only a
  // key still inside its upload window matches.
  const claimed = UPLOAD_KEY_RE.test(upload.key) && await tx
    .deleteFrom('records_attachment_trash')
    .where('storage_key', '=', upload.key)
    .where('deleted_at', '>', sql<Date>`now()`)
    .returning('storage_key')
    .executeTakeFirst()
  if (!claimed) {
    throw createError({ statusCode: 400, statusMessage: 'Unknown upload key: it has expired, was already used, or was never handed out.' })
  }
  const stat = await statS3Object(upload.key)
  if (!stat) {
    throw createError({ statusCode: 404, statusMessage: 'Nothing has been uploaded to this key yet. PUT the file to the upload URL first.' })
  }
  assertAttachmentSize(stat.size)
  const sortOrder = await nextSortOrder(tx, recordId, fieldKey)
  return await insertAttachment(tx, ctx, recordId, fieldKey, {
    storageKey: upload.key,
    filename: upload.filename,
    mime: stat.contentType || 'application/octet-stream',
    size: stat.size,
    sortOrder
  })
}

function assertAttachmentSize(bytes: number): void {
  if (!validateFileSize(bytes, RECORDS_ATTACHMENT_MAX_MB)) {
    throw createError({ statusCode: 413, statusMessage: `File too large (max ${RECORDS_ATTACHMENT_MAX_MB} MB).` })
  }
}

// The sort order that puts a new file last on the field; refuses a full field.
async function nextSortOrder(tx: Tx, recordId: string, fieldKey: string): Promise<number> {
  const stats = await tx
    .selectFrom('records_attachments')
    .select(eb => [eb.fn.countAll<string>().as('n'), eb.fn.max('sort_order').as('max')])
    .where('record_id', '=', recordId)
    .where('field_key', '=', fieldKey)
    .executeTakeFirst()
  if (Number(stats?.n ?? 0) >= RECORDS_ATTACHMENTS_PER_FIELD) {
    throw createError({ statusCode: 400, statusMessage: `A field holds at most ${RECORDS_ATTACHMENTS_PER_FIELD} files.` })
  }
  return (stats?.max ?? -1) + 1
}

async function insertAttachment(
  tx: Tx,
  ctx: TenantContext,
  recordId: string,
  fieldKey: string,
  file: { storageKey: string, filename: string, mime: string, size: number, sortOrder: number }
): Promise<RecordsAttachmentValue> {
  const row = await tx
    .insertInto('records_attachments')
    .values({
      record_id: recordId,
      field_key: fieldKey,
      storage_key: file.storageKey,
      filename: file.filename,
      mime: file.mime,
      size_bytes: file.size,
      sort_order: file.sortOrder,
      created_by: ctx.userId
    })
    .returning(['id', 'record_id', 'field_key', 'storage_key', 'filename', 'mime', 'size_bytes'])
    .executeTakeFirstOrThrow()
  return await toValue(row)
}

/**
 * Applies a field patch to an attachments field: the listed file ids are the
 * ones to keep (a full list, in the new order) or to remove (`delete`). Ids
 * not already on the field are refused — files arrive by upload only.
 */
export async function applyAttachmentsPatch(
  tx: Tx,
  recordId: string,
  fieldKey: string,
  list: RecordsListPatch
): Promise<void> {
  const current = await tx
    .selectFrom('records_attachments')
    .select('id')
    .where('record_id', '=', recordId)
    .where('field_key', '=', fieldKey)
    .orderBy('sort_order', 'asc')
    .execute()
  const onField = new Set(current.map(r => r.id))
  const keep = list.items.filter(i => !i.delete).map(i => String(i.value))
  const unknown = keep.find(id => !onField.has(id))
  if (unknown) {
    throw createError({ statusCode: 400, statusMessage: `${fieldKey}: file ${unknown} is not on this field — upload files through the attachments route` })
  }
  const removed = list.force
    ? current.map(r => r.id).filter(id => !keep.includes(id))
    : list.items.filter(i => i.delete).map(i => String(i.value))
  if (removed.length > 0) {
    await tx
      .deleteFrom('records_attachments')
      .where('record_id', '=', recordId)
      .where('field_key', '=', fieldKey)
      .where('id', 'in', removed)
      .execute()
  }
  if (list.force) {
    for (const [index, id] of keep.entries()) {
      await tx.updateTable('records_attachments').set({ sort_order: index }).where('id', '=', id).execute()
    }
  }
}

/** Removes every file on the given fields of the given records (all records when `recordIds` is omitted). */
export async function deleteRecordAttachments(
  tx: Tx,
  opts: { fieldKeys?: string[], fieldKeyPrefix?: string, recordIds?: string[] }
): Promise<void> {
  if (!opts.fieldKeys && !opts.fieldKeyPrefix) return
  let query = tx.deleteFrom('records_attachments')
  if (opts.fieldKeys) {
    if (opts.fieldKeys.length === 0) return
    query = query.where('field_key', 'in', opts.fieldKeys)
  }
  if (opts.fieldKeyPrefix) {
    const escaped = opts.fieldKeyPrefix.replace(/[\\%_]/g, m => `\\${m}`)
    query = query.where('field_key', 'like', `${escaped}%`)
  }
  if (opts.recordIds) {
    if (opts.recordIds.length === 0) return
    query = query.where('record_id', 'in', opts.recordIds)
  }
  await query.execute()
}

/**
 * Copies the files on the given fields of one record onto another, each into
 * its own new object in storage, keeping field and order. Returns old file id
 * → new file id. Like an upload, each copy is queued for the sweep until the
 * transaction takes it off the queue.
 */
export async function copyRecordAttachments(
  tx: Tx,
  ctx: TenantContext,
  fromRecordId: string,
  toRecordId: string,
  opts: { fieldKeys?: string[], fieldKeyPrefix?: string }
): Promise<Map<string, string>> {
  const ids = new Map<string, string>()
  if (!opts.fieldKeys && !opts.fieldKeyPrefix) return ids
  let query = tx
    .selectFrom('records_attachments')
    .select(['id', 'field_key', 'storage_key', 'filename', 'mime', 'size_bytes', 'sort_order'])
    .where('record_id', '=', fromRecordId)
  if (opts.fieldKeys) {
    if (opts.fieldKeys.length === 0) return ids
    query = query.where('field_key', 'in', opts.fieldKeys)
  }
  if (opts.fieldKeyPrefix) {
    const escaped = opts.fieldKeyPrefix.replace(/[\\%_]/g, m => `\\${m}`)
    query = query.where('field_key', 'like', `${escaped}%`)
  }
  const rows = await query.orderBy('sort_order', 'asc').orderBy('created_at', 'asc').execute()
  for (const row of rows) {
    const key = await copyS3Object(row.storage_key, 'records')
    await db.insertInto('records_attachment_trash').values({ storage_key: key }).execute()
    await tx.deleteFrom('records_attachment_trash').where('storage_key', '=', key).execute()
    const copy = await tx
      .insertInto('records_attachments')
      .values({
        record_id: toRecordId,
        field_key: row.field_key,
        storage_key: key,
        filename: row.filename,
        mime: row.mime,
        size_bytes: row.size_bytes,
        sort_order: row.sort_order,
        created_by: ctx.userId
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    ids.set(row.id, copy.id)
  }
  return ids
}

/**
 * Deletes queued objects from storage, a batch at a time. A key whose delete
 * fails stays queued for the next sweep.
 */
export async function sweepAttachmentTrash(batch = 100): Promise<number> {
  const rows = await db
    .selectFrom('records_attachment_trash')
    .select('storage_key')
    .where('deleted_at', '<', sql<Date>`now() - ${TRASH_GRACE}`)
    .orderBy('deleted_at', 'asc')
    .limit(batch)
    .execute()
  let deleted = 0
  for (const { storage_key } of rows) {
    try {
      await deleteFromS3(storage_key)
    } catch {
      continue
    }
    await db.deleteFrom('records_attachment_trash').where('storage_key', '=', storage_key).execute()
    deleted++
  }
  return deleted
}
