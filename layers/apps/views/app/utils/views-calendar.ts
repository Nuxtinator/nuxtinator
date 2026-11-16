// Day arithmetic for calendar tabs. Days are local-calendar 'YYYY-MM-DD'
// keys: a date field's value is already one, and a datetime lands on the day
// it falls on in the viewer's timezone.
import type { ViewsBoardItem } from './views-types'
import { VIEWS_FIELD_KEY_PREFIX } from './views-fields'

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** The local day `date` falls on. */
export function viewsDayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Local midnight of `day`. */
export function viewsDayDate(day: string): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  return new Date(y, m - 1, d)
}

export function viewsShiftDay(day: string, by: number): string {
  const date = viewsDayDate(day)
  date.setDate(date.getDate() + by)
  return viewsDayKey(date)
}

/** Whole days from `a` to `b`. */
export function viewsDaysBetween(a: string, b: string): number {
  return Math.round((viewsDayDate(b).getTime() - viewsDayDate(a).getTime()) / 86_400_000)
}

/** The month (YYYY-MM) `by` months from `month`. */
export function viewsShiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const date = new Date(y, m - 1 + by, 1)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`
}

/** The first day of the week in the viewer's locale: 0 = Sunday … 6 = Saturday. */
export function viewsWeekStart(): number {
  try {
    const locale = new Intl.Locale(navigator.language) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number }
      weekInfo?: { firstDay: number }
    }
    const info = locale.getWeekInfo?.() ?? locale.weekInfo
    if (info?.firstDay) return info.firstDay % 7
  } catch {
    // Older browsers: weeks start on Sunday.
  }
  return 0
}

/** The days a month grid shows: whole weeks from the one holding the 1st to the one holding the last day. */
export function viewsMonthGrid(month: string, weekStart: number): string[] {
  const first = viewsDayDate(`${month}-01`)
  const start = new Date(first)
  start.setDate(1 - ((first.getDay() - weekStart + 7) % 7))
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0)
  const end = new Date(last)
  end.setDate(last.getDate() + ((weekStart + 6 - last.getDay()) % 7))
  const days: string[] = []
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) days.push(viewsDayKey(d))
  return days
}

/** A record's raw value for `key`: a timestamp, one of the view's own values, or a jsonb field. */
export function viewsItemValue(item: ViewsBoardItem, key: string): unknown {
  if (key === 'created_at') return item.createdAt
  if (key === 'updated_at') return item.updatedAt
  if (key.startsWith(VIEWS_FIELD_KEY_PREFIX)) return item.viewValues?.[key] ?? null
  return item.data[key] ?? null
}

/** The day a stored date or datetime value falls on, or null when unset. */
export function viewsValueDay(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : viewsDayKey(date)
}

/**
 * The value that puts a field on `day`: a plain day for a date field; for a
 * datetime, the same time of day as `previous` (else local midnight).
 */
export function viewsValueOnDay(kind: string, day: string, previous: unknown): string {
  if (kind !== 'datetime') return day
  const date = viewsDayDate(day)
  if (typeof previous === 'string' && previous !== '') {
    const before = new Date(previous)
    if (!Number.isNaN(before.getTime())) date.setHours(before.getHours(), before.getMinutes(), before.getSeconds())
  }
  return date.toISOString()
}
