// The fields that hang off a type's due date: repeat and reminder. Both need
// a due date, and clearing the due date clears them.

import { RECORDS_REMINDER_KEY, RECORDS_REMINDER_OFFSETS, RECORDS_REPEAT_KEY } from '#records'
import type { RecordsFieldSetting } from './definition-settings'

export interface RecordsDateShift {
  months: number
  days: number
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const DUE_DEPENDENT_KEYS = [RECORDS_REPEAT_KEY, RECORDS_REMINDER_KEY]

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
}

/**
 * Moves a date or ISO timestamp by whole months (to the same day, or the
 * month's last day when it has fewer), then by days. Either may be negative.
 */
export function recordsShiftDate(value: string, shift: RecordsDateShift): string {
  const dateOnly = DATE_ONLY.test(value)
  const date = new Date(dateOnly ? `${value}T00:00:00Z` : value)
  const day = date.getUTCDate()
  const months = date.getUTCMonth() + shift.months
  const year = date.getUTCFullYear() + Math.floor(months / 12)
  const month = ((months % 12) + 12) % 12
  date.setUTCFullYear(year, month, Math.min(day, daysInMonth(year, month)))
  date.setUTCDate(date.getUTCDate() + shift.days)
  return dateOnly ? date.toISOString().slice(0, 10) : date.toISOString()
}

/** Today's date (UTC), YYYY-MM-DD. */
export function recordsToday(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}

export function recordsDueField(defs: RecordsFieldSetting[]): RecordsFieldSetting | undefined {
  return defs.find(d => d.due && !d.orphan)
}

/** The day a reminder option falls on for a due date (YYYY-MM-DD), or null. */
export function recordsReminderDay(due: unknown, option: unknown): string | null {
  if (typeof due !== 'string' || typeof option !== 'string') return null
  const offset = RECORDS_REMINDER_OFFSETS[option]
  if (!offset) return null
  return recordsShiftDate(due.slice(0, 10), { months: -(offset.months ?? 0), days: -(offset.days ?? 0) })
}

/**
 * Checks a patch against the due-date rules before it is written: clearing
 * the due date also clears the fields that need one, and setting one of them
 * needs a due date. `before` is the record's current field values (null on
 * create).
 */
export function enforceDueDateRules(
  defs: RecordsFieldSetting[],
  scalarOps: Map<string, unknown>,
  before: Record<string, unknown> | null
): void {
  const due = recordsDueField(defs)
  if (!due) return
  const keys = DUE_DEPENDENT_KEYS.filter(key => defs.some(d => d.key === key))
  if (!scalarOps.has(due.key) && !keys.some(key => scalarOps.has(key))) return
  const nextDue = scalarOps.has(due.key) ? scalarOps.get(due.key) : before?.[due.key] ?? null
  for (const key of keys) {
    if (nextDue === null && !scalarOps.has(key) && before?.[key] != null) scalarOps.set(key, null)
    const next = scalarOps.has(key) ? scalarOps.get(key) : before?.[key] ?? null
    if (next != null && nextDue == null) {
      throw createError({ statusCode: 400, statusMessage: `${key}: set ${due.key} first — it counts from the due date.` })
    }
  }
}
