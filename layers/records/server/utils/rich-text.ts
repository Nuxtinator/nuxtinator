// Reading rich text values (Markdown) on the server. A person mentioned in
// one is the editor's mention node, `[@ id="<user id>" label="Name"]`; a link
// to a record is the same node with `char="#"` and an id of
// `<type key>/<record id>`, and is not a mention. An image is a file on the
// record, `![name](attachment:<file id>)`.
import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'

const MENTION_RE = /\[@\s+([^\]]*)\]/g
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The ids of the people a rich text value mentions, without repeats. */
export function recordsMentionedUserIds(value: unknown): string[] {
  if (typeof value !== 'string') return []
  const ids = new Set<string>()
  for (const match of value.matchAll(MENTION_RE)) {
    const attrs = match[1] ?? ''
    const char = /(?:^|\s)char="([^"]*)"/.exec(attrs)?.[1]
    const id = /(?:^|\s)id="([^"]*)"/.exec(attrs)?.[1]
    if ((char === undefined || char === '@') && id && UUID_RE.test(id)) ids.add(id.toLowerCase())
  }
  return [...ids]
}

/** The ids of the records a rich text value links to ("#" chips), without repeats. */
export function recordsLinkedRecordIds(value: unknown): string[] {
  if (typeof value !== 'string') return []
  const ids = new Set<string>()
  for (const match of value.matchAll(MENTION_RE)) {
    const attrs = match[1] ?? ''
    if (/(?:^|\s)char="([^"]*)"/.exec(attrs)?.[1] !== '#') continue
    const id = /(?:^|\s)id="[^"/]+\/([^"]*)"/.exec(attrs)?.[1]
    if (id && UUID_RE.test(id)) ids.add(id.toLowerCase())
  }
  return [...ids]
}

/**
 * Rewrites the links one rich text field of a record holds to other records
 * (records_mentions) from the field's new value. Links to records that don't
 * exist, or to the record itself, are dropped.
 */
export async function syncRecordsRichTextLinks(
  tx: Transaction<Database>,
  recordId: string,
  fieldKey: string,
  value: unknown
): Promise<void> {
  const linked = recordsLinkedRecordIds(value).filter(id => id !== recordId.toLowerCase())
  const targets = linked.length > 0
    ? (await tx.selectFrom('records_entries').select('id').where('id', 'in', linked).execute()).map(row => row.id)
    : []
  let stale = tx.deleteFrom('records_mentions').where('from_record_id', '=', recordId).where('field_key', '=', fieldKey)
  if (targets.length > 0) stale = stale.where('to_record_id', 'not in', targets)
  await stale.execute()
  if (targets.length === 0) return
  await tx
    .insertInto('records_mentions')
    .values(targets.map(to => ({ from_record_id: recordId, field_key: fieldKey, to_record_id: to })))
    .onConflict(oc => oc.doNothing())
    .execute()
}

const IMAGE_RE = /!\[[^\]]*\]\(attachment:([0-9a-f-]{36})\)/gi

/** The ids of the record files a rich text value shows as images. */
export function recordsImageFileIds(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return [...new Set([...value.matchAll(IMAGE_RE)].map(match => match[1]!.toLowerCase()))]
}

/**
 * Keeps a record's rich text and its files in step after a write: a file whose
 * image the write took out of the text is deleted, and an image whose file is
 * gone is taken out of the text. `before` holds the record's field values
 * before the write (null for a new record). A file the text never showed is
 * left alone.
 */
export async function syncRecordsRichTextImages(
  tx: Transaction<Database>,
  recordId: string,
  richTextKeys: string[],
  before: Record<string, unknown> | null
): Promise<void> {
  const row = await tx.selectFrom('records_entries').select('data').where('id', '=', recordId).executeTakeFirst()
  const data = (row?.data ?? {}) as Record<string, unknown>
  const shown = new Set(richTextKeys.flatMap(key => recordsImageFileIds(data[key])))

  const dropped = [...new Set(richTextKeys.flatMap(key => recordsImageFileIds(before?.[key])))].filter(id => !shown.has(id))
  if (dropped.length > 0) {
    await tx.deleteFrom('records_attachments').where('record_id', '=', recordId).where('id', 'in', dropped).execute()
  }
  if (shown.size === 0) return

  const files = await tx
    .selectFrom('records_attachments')
    .select('id')
    .where('record_id', '=', recordId)
    .where('id', 'in', [...shown])
    .execute()
  const present = new Set(files.map(file => file.id.toLowerCase()))
  const sets: Record<string, string> = {}
  const removes: string[] = []
  for (const key of richTextKeys) {
    const text = data[key]
    if (typeof text !== 'string') continue
    const next = text.replace(IMAGE_RE, (whole, id: string) => present.has(id.toLowerCase()) ? whole : '')
    if (next === text) continue
    if (next.trim() === '') removes.push(key)
    else sets[key] = next
  }
  if (removes.length === 0 && Object.keys(sets).length === 0) return
  await tx
    .updateTable('records_entries')
    .set({ data: sql`(data - ${removes}::text[]) || ${JSON.stringify(sets)}::text::jsonb` })
    .where('id', '=', recordId)
    .execute()
}
