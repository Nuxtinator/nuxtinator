// Repeating records: the copy closing one makes (see the records README,
// "Repeat").

import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { TenantContext } from '#tenant/server'
import { RECORDS_REPEAT_INTERVALS, RECORDS_REPEAT_KEY } from '#records'
import type { RecordsConnectedRecord, RecordsRefValue } from '#records'
import { recordsHierarchyOf, type RecordsFieldSetting, type RecordTypeSetting } from './definition-settings'
import { closingRulesOf } from './closing'
import { applyFieldPatch, getRecord, type RecordsHydratedRecord } from './record-storage'
import { recordRecordsActivity } from './records-activity'
import { runRecordsRepeatHooks, type RecordsFieldPatch } from './records-registry'
import { copyRecordAttachments } from './attachments'
import { syncRecordsRichTextLinks } from './rich-text'
import { recordsDueField, recordsShiftDate, recordsToday, type RecordsDateShift } from './due-date'

type Tx = Transaction<Database>

function isPast(value: string, now: Date): boolean {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value < recordsToday(now)
  return new Date(value).getTime() <= now.getTime()
}

/**
 * How far the next record's dates move: whole intervals from the due date
 * until it is no longer past. Null when the option has no interval.
 */
export function recordsRepeatShift(due: string, option: string, now = new Date()): RecordsDateShift | null {
  const interval = RECORDS_REPEAT_INTERVALS[option]
  if (!interval) return null
  for (let n = 1; n <= 5000; n++) {
    const shift = { months: (interval.months ?? 0) * n, days: (interval.days ?? 0) * n }
    if (!isPast(recordsShiftDate(due, shift), now)) return shift
  }
  return null
}

function connectionIds(value: unknown): string[] {
  return Array.isArray(value) ? (value as RecordsConnectedRecord[]).map(v => v.id) : []
}

// The copy's starting values. Files and rich text follow once the copy
// exists, so the text can point at the copied files.
function copyPatch(
  record: RecordsHydratedRecord,
  defs: RecordsFieldSetting[],
  skip: Set<string>,
  shift: RecordsDateShift
): RecordsFieldPatch {
  const patch: RecordsFieldPatch = {}
  for (const def of defs) {
    if (def.orphan || skip.has(def.key)) continue
    if (def.column === 'status' || def.hierarchy === 'children') continue
    if (def.storage === 'attachments' || def.storage === 'channels' || def.kind === 'rich_text') continue
    const value = record.fields[def.key]
    if (value === null || value === undefined) continue
    if (def.kind === 'date' || def.kind === 'datetime') {
      patch[def.key] = typeof value === 'string' ? recordsShiftDate(value, shift) : value
    } else if (def.storage === 'connections') {
      patch[def.key] = connectionIds(value)
    } else if (def.kind === 'ref') {
      patch[def.key] = (value as RecordsRefValue).id
    } else {
      patch[def.key] = value
    }
  }
  return patch
}

// Copies one record (not its children) and everything that rides on it.
async function copyRecord(
  tx: Tx,
  ctx: TenantContext,
  typeKey: string,
  record: RecordsHydratedRecord,
  defs: RecordsFieldSetting[],
  skip: Set<string>,
  shift: RecordsDateShift,
  overrides: RecordsFieldPatch
): Promise<RecordsHydratedRecord> {
  const copy = await applyFieldPatch(tx, ctx, typeKey, null, { ...copyPatch(record, defs, skip, shift), ...overrides })

  await tx.updateTable('records_entries').set({ created_by: record.createdBy }).where('id', '=', copy.id).execute()
  await sql`
    INSERT INTO records_shares (record_id, user_id, level, granted_by)
    SELECT ${copy.id}::uuid, user_id, level, granted_by FROM records_shares WHERE record_id = ${record.id}::uuid
    ON CONFLICT DO NOTHING
  `.execute(tx)
  await sql`
    UPDATE records_reminders r SET set_by = o.set_by
    FROM records_reminders o
    WHERE r.record_id = ${copy.id}::uuid AND o.record_id = ${record.id}::uuid
  `.execute(tx)

  const fileKeys = defs.filter(d => d.storage === 'attachments' && !d.orphan).map(d => d.key)
  const fileIds = await copyRecordAttachments(tx, ctx, record.id, copy.id, { fieldKeys: fileKeys })
  const texts: Record<string, string> = {}
  for (const def of defs) {
    const text = record.fields[def.key]
    if (def.kind !== 'rich_text' || def.orphan || typeof text !== 'string') continue
    texts[def.key] = text.replace(/\(attachment:([0-9a-f-]{36})\)/gi, (whole, id: string) => {
      const next = fileIds.get(id.toLowerCase())
      return next ? `(attachment:${next})` : whole
    })
  }
  if (Object.keys(texts).length > 0) {
    await tx
      .updateTable('records_entries')
      .set({ data: sql`data || ${JSON.stringify(texts)}::text::jsonb` })
      .where('id', '=', copy.id)
      .execute()
    for (const [key, text] of Object.entries(texts)) await syncRecordsRichTextLinks(tx, copy.id, key, text)
  }

  await runRecordsRepeatHooks(tx, ctx, { typeKey, fromRecordId: record.id, toRecordId: copy.id })
  return copy
}

// Copies the records under `parent` to sit under `toParentId`, to any depth.
async function copyChildren(
  tx: Tx,
  ctx: TenantContext,
  typeKey: string,
  defs: RecordsFieldSetting[],
  parentKey: string,
  childrenKey: string,
  parent: RecordsHydratedRecord,
  toParentId: string,
  shift: RecordsDateShift
): Promise<void> {
  for (const childId of connectionIds(parent.fields[childrenKey])) {
    const child = await getRecord(tx, ctx, typeKey, childId)
    const copy = await copyRecord(tx, ctx, typeKey, child, defs, new Set([RECORDS_REPEAT_KEY]), shift, { [parentKey]: [toParentId] })
    await copyChildren(tx, ctx, typeKey, defs, parentKey, childrenKey, child, copy.id, shift)
  }
}

/** Makes the next record after a repeating one closed; returns whether it did. */
export async function repeatClosedRecord(
  tx: Tx,
  ctx: TenantContext,
  type: RecordTypeSetting,
  defs: RecordsFieldSetting[],
  record: RecordsHydratedRecord
): Promise<boolean> {
  const due = recordsDueField(defs)
  const option = record.fields[RECORDS_REPEAT_KEY]
  const dueValue = due ? record.fields[due.key] : null
  if (!due || typeof option !== 'string' || typeof dueValue !== 'string') return false
  const shift = recordsRepeatShift(dueValue, option)
  if (!shift) return false

  const reasonKey = closingRulesOf(type, defs).reasonKey
  const skip = new Set(reasonKey ? [reasonKey] : [])
  const next = await copyRecord(tx, ctx, type.key, record, defs, skip, shift, {})
  // What sits under it of its own type (a task's subtasks) is copied along.
  const own = recordsHierarchyOf(defs)?.children.find(c => c.target === type.key)
  if (own) {
    await copyChildren(tx, ctx, type.key, defs, own.parentKey, own.key, record, next.id, shift)
  }

  await tx
    .updateTable('records_entries')
    .set({ data: sql`data - ${RECORDS_REPEAT_KEY}::text` })
    .where('id', '=', record.id)
    .execute()
  await recordRecordsActivity(tx, ctx, record.id, 'field_changed', { fieldKey: RECORDS_REPEAT_KEY, old: option, new: null })
  const nextDue = next.fields[due.key]
  await recordRecordsActivity(tx, ctx, record.id, 'repeated', {
    new: { id: next.id, name: next.name },
    note: typeof nextDue === 'string' ? `The next one is due ${nextDue.slice(0, 10)}.` : undefined
  })
  await recordRecordsActivity(tx, ctx, next.id, 'repeat_created', {
    old: { id: record.id, name: record.name },
    note: `Follows the one due ${dueValue.slice(0, 10)}.`
  })
  return true
}
