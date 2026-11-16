// How the UI writes a moment in time: "Nov 12, 2026, 8:44 PM" in the viewer's locale, with no seconds.
// A missing or unreadable value becomes an em dash.
type DateInput = string | number | Date | null | undefined

const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const dateOnlyFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

function format(value: DateInput, formatter: Intl.DateTimeFormat): string {
  if (value === null || value === undefined || value === '') return '—'
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : formatter.format(date)
}

export const formatDateTime = (value: DateInput): string => format(value, dateTimeFormat)

export const formatDateOnly = (value: DateInput): string => format(value, dateOnlyFormat)
