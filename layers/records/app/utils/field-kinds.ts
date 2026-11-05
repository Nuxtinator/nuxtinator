// Client-side field-kind dispatcher — the single registry mapping each
// RecordsFieldKind to how it renders: an optional inline editor component and a
// plain-text formatter used by table cells and read-only detail rows.
// Kinds without an editor component render read-only here; on the detail
// page a registered field widget may take over (the crm layer's channel
// widget for communication_channel).

import type { RecordsFieldKind, RecordsFieldOption, RecordsLinkValue } from '#records'

/** A merged field definition as served by GET /api/records/schema/types/:type/fields. */
export interface RecordsFieldSetting {
  key: string
  kind: RecordsFieldKind
  label: string
  icon: string | null
  section: string | null
  required: boolean
  hidden: boolean
  order: number
  options: Record<string, RecordsFieldOption> | null
  custom: boolean
  orphan: boolean
  channelType: string | null
  target: string | null
  multiple: boolean
  /** Promoted-column flag — 'name'/'status' fields live on the record row. */
  column: 'name' | 'status' | null
}

/** Section map as served alongside the fields (`sections` in the response). */
export type RecordsTypeSections = Record<string, { label: string, order?: number }>

/** Extra lookups a formatter may use; every entry is optional. */
export interface RecordsFormatContext {
  /** Resolves a user id to a display name (see useRecordsUsers().userName). */
  userName?: (id: string) => string | null
}

export interface RecordsKindRenderer {
  /** Inline editor component (auto-named Records*); absent = read-only display. */
  component?: string
  /** Plain-text rendering for table cells and read-only rows. */
  format: (value: unknown, field: RecordsFieldSetting, ctx?: RecordsFormatContext) => string
}

const EMPTY = '—'

/** Badge palette — option colors outside this set fall back to neutral. */
const BADGE_COLORS = new Set(['primary', 'secondary', 'success', 'info', 'warning', 'error', 'neutral'])
export type RecordsBadgeColor = 'primary' | 'secondary' | 'success' | 'info' | 'warning' | 'error' | 'neutral'

export function recordsOptionLabel(field: RecordsFieldSetting, key: string): string {
  return field.options?.[key]?.label ?? key
}

export function recordsOptionColor(field: RecordsFieldSetting, key: string | null | undefined): RecordsBadgeColor {
  const color = key ? field.options?.[key]?.color : undefined
  return color && BADGE_COLORS.has(color) ? color as RecordsBadgeColor : 'neutral'
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function formatText(value: unknown): string {
  if (value === null || value === undefined || value === '') return EMPTY
  return String(value)
}

function formatDateValue(value: unknown, withTime: boolean): string {
  if (typeof value !== 'string' || value === '') return EMPTY
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return EMPTY
  return withTime ? d.toLocaleString() : d.toLocaleDateString()
}

export const RECORDS_FIELD_KINDS: Record<RecordsFieldKind, RecordsKindRenderer> = {
  text: {
    component: 'RecordsFieldsTextField',
    format: formatText
  },
  textarea: {
    component: 'RecordsFieldsTextareaField',
    format: formatText
  },
  number: {
    component: 'RecordsFieldsNumberField',
    format: value => typeof value === 'number' ? value.toLocaleString() : formatText(value)
  },
  boolean: {
    component: 'RecordsFieldsBooleanField',
    format: value => value === null || value === undefined ? EMPTY : (value ? 'Yes' : 'No')
  },
  date: {
    component: 'RecordsFieldsDateField',
    format: value => formatDateValue(value, false)
  },
  datetime: {
    component: 'RecordsFieldsDatetimeField',
    format: value => formatDateValue(value, true)
  },
  key_select: {
    component: 'RecordsFieldsKeySelectField',
    format: (value, field) =>
      typeof value === 'string' && value !== '' ? recordsOptionLabel(field, value) : EMPTY
  },
  multi_select: {
    component: 'RecordsFieldsMultiSelectField',
    format: (value, field) => {
      const keys = asArray(value)
      if (keys.length === 0) return EMPTY
      return keys.map(k => recordsOptionLabel(field, String(k))).join(', ')
    }
  },
  tags: {
    component: 'RecordsFieldsTagsField',
    format: (value) => {
      const tags = asArray(value)
      return tags.length > 0 ? tags.map(String).join(', ') : EMPTY
    }
  },
  user_select: {
    component: 'RecordsFieldsUserSelectField',
    format: (value, _field, ctx) => {
      const ids = Array.isArray(value)
        ? value.map(String)
        : (typeof value === 'string' && value !== '' ? [value] : [])
      if (ids.length === 0) return EMPTY
      if (ctx?.userName) return ids.map(id => ctx.userName!(id) ?? id).join(', ')
      return ids.length === 1 ? '1 user' : `${ids.length} users`
    }
  },
  communication_channel: {
    // Driver-shaped entries; every shape carries the address as `value`.
    format: (value) => {
      const entries = asArray(value) as Array<{ value?: unknown }>
      return entries.length > 0 ? entries.map(e => String(e.value ?? '')).join(', ') : EMPTY
    }
  },
  connection: {
    component: 'RecordsFieldsConnectionField',
    // Count only — list rows never carry connection values, and the detail
    // page renders names through the editor and the connections panel.
    format: (value) => {
      const ids = asArray(value)
      if (ids.length === 0) return EMPTY
      return ids.length === 1 ? '1 linked' : `${ids.length} linked`
    }
  },
  link: {
    component: 'RecordsFieldsLinkField',
    format: (value) => {
      const links = asArray(value) as RecordsLinkValue[]
      return links.length > 0 ? links.map(l => l.label || l.url).join(', ') : EMPTY
    }
  }
}

/** Unknown kinds (stale orphan fields) fall back to plain-text display. */
export function recordsRendererFor(kind: string): RecordsKindRenderer {
  return RECORDS_FIELD_KINDS[kind as RecordsFieldKind] ?? { format: formatText }
}

export function formatRecordsValue(value: unknown, field: RecordsFieldSetting, ctx?: RecordsFormatContext): string {
  return recordsRendererFor(field.kind).format(value, field, ctx)
}

/** Human-readable message from a $fetch error (statusMessage detail first). */
export function recordsErrorMessage(err: unknown, fallback: string): string {
  return (err as { data?: { statusMessage?: string } } | null)?.data?.statusMessage
    || (err as { message?: string } | null)?.message
    || fallback
}
