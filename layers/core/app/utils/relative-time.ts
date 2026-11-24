// Text for <RelativeTime>: the compact relative form, the exact time it toggles
// to, and the full time its tooltip shows. All use the browser's locale and time zone.

export type TimestampValue = string | number | Date | null | undefined

// Accepts an ISO string, epoch milliseconds or a Date; null when it isn't a valid time.
export function timestampDate(value: TimestampValue): Date | null {
  if (value === null || value === undefined || value === '') return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

// "just now", "5m ago", "3h ago", "2d ago", then the date alone.
export function relativeTimeText(d: Date, now: number = Date.now()): string {
  const seconds = Math.floor((now - d.getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return d.toLocaleDateString()
}

// "Nov 11, 2:32:07 PM"; the year is added when it isn't the current one.
export function exactTimeText(d: Date, now: number = Date.now()): string {
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit'
  })
}

// "Wednesday, November 11, 2026 at 2:32:07 PM GMT+1"
export function fullTimeText(d: Date): string {
  return d.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'long' })
}
