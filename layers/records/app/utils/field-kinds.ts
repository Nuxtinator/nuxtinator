// Client-side field-kind dispatcher — the single registry mapping each
// RecordsFieldKind to how it renders: a default icon, an optional inline
// editor component and a plain-text formatter used by table cells and
// read-only detail rows.
// Kinds without an editor component render read-only here; on the detail
// page a registered field widget may take over (the crm layer's channel
// widget for communication_channel).

import type { RecordsAttachmentValue, RecordsFieldKind, RecordsFieldOption, RecordsLinkValue, RecordsRefValue } from '#records'

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
  /** connection: the parent or children side of the type's hierarchy. */
  hierarchy?: 'parent' | 'children' | null
  /** ref: the registered ref source its ids belong to. */
  source?: string | null
  multiple: boolean
  /** Promoted-column flag — 'name'/'status' fields live on the record row. */
  column: 'name' | 'status' | null
  /** The value a new record starts with, when the type declares one. */
  default?: unknown
}

/** Section map as served alongside the fields (`sections` in the response). */
export type RecordsTypeSections = Record<string, { label: string, order?: number }>

/** Extra lookups a formatter may use; every entry is optional. */
export interface RecordsFormatContext {
  /** Resolves a user id to a display name (see useRecordsUsers().userName). */
  userName?: (id: string) => string | null
}

export interface RecordsKindRenderer {
  /** Stands for a field of this kind that has no icon of its own. */
  icon: string
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

/** A record link (`char="#"`) or a person as rich text stores them: `[@ id="…" label="Name"]`. */
const RICH_TEXT_MENTION_RE = /\[@\s+([^\]]*)\]/g

/**
 * A rich text value (Markdown) as one run of plain text, for table cells,
 * cards and activity rows: links, images, record links and people keep their
 * text, and heading, list, checkbox, quote and emphasis marks are dropped.
 */
export function recordsPlainText(markdown: string): string {
  return markdown
    .replace(RICH_TEXT_MENTION_RE, (_m, attrs: string) => {
      const label = /label="([^"]*)"/.exec(attrs)?.[1]
      const char = /char="([^"]*)"/.exec(attrs)?.[1] ?? '@'
      return label ? `${char}${label}` : ''
    })
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)(?:\[[ xX]\]\s+)?/gm, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export const RECORDS_FIELD_KINDS: Record<RecordsFieldKind, RecordsKindRenderer> = {
  text: {
    icon: 'i-lucide-type',
    component: 'RecordsFieldsTextField',
    format: formatText
  },
  textarea: {
    icon: 'i-lucide-align-left',
    component: 'RecordsFieldsTextareaField',
    format: formatText
  },
  rich_text: {
    icon: 'i-lucide-align-left',
    component: 'RecordsFieldsRichTextField',
    format: value => typeof value === 'string' && value.trim() !== '' ? recordsPlainText(value) || EMPTY : EMPTY
  },
  number: {
    icon: 'i-lucide-hash',
    component: 'RecordsFieldsNumberField',
    format: value => typeof value === 'number' ? value.toLocaleString() : formatText(value)
  },
  boolean: {
    icon: 'i-lucide-square-check',
    component: 'RecordsFieldsBooleanField',
    format: value => value === null || value === undefined ? EMPTY : (value ? 'Yes' : 'No')
  },
  date: {
    icon: 'i-lucide-calendar',
    component: 'RecordsFieldsDateField',
    format: value => formatDateValue(value, false)
  },
  datetime: {
    icon: 'i-lucide-clock',
    component: 'RecordsFieldsDatetimeField',
    format: value => formatDateValue(value, true)
  },
  key_select: {
    icon: 'i-lucide-circle-chevron-down',
    component: 'RecordsFieldsKeySelectField',
    format: (value, field) =>
      typeof value === 'string' && value !== '' ? recordsOptionLabel(field, value) : EMPTY
  },
  multi_select: {
    icon: 'i-lucide-list-checks',
    component: 'RecordsFieldsMultiSelectField',
    format: (value, field) => {
      const keys = asArray(value)
      if (keys.length === 0) return EMPTY
      return keys.map(k => recordsOptionLabel(field, String(k))).join(', ')
    }
  },
  tags: {
    icon: 'i-lucide-tags',
    component: 'RecordsFieldsTagsField',
    format: (value) => {
      const tags = asArray(value)
      return tags.length > 0 ? tags.map(String).join(', ') : EMPTY
    }
  },
  user_select: {
    icon: 'i-lucide-users',
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
    icon: 'i-lucide-at-sign',
    // Driver-shaped entries; every shape carries the address as `value`.
    format: (value) => {
      const entries = asArray(value) as Array<{ value?: unknown }>
      return entries.length > 0 ? entries.map(e => String(e.value ?? '')).join(', ') : EMPTY
    }
  },
  connection: {
    icon: 'i-lucide-waypoints',
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
    icon: 'i-lucide-link',
    component: 'RecordsFieldsLinkField',
    format: (value) => {
      const links = asArray(value) as RecordsLinkValue[]
      return links.length > 0 ? links.map(l => l.label || l.url).join(', ') : EMPTY
    }
  },
  attachments: {
    icon: 'i-lucide-paperclip',
    component: 'RecordsFieldsAttachmentsField',
    // Hydrated files and timeline entries both carry the file name.
    format: (value) => {
      const files = asArray(value) as Array<{ name?: string }>
      return files.length > 0 ? files.map(f => f.name ?? '').join(', ') : EMPTY
    }
  },
  ref: {
    icon: 'i-lucide-link',
    component: 'RecordsFieldsRefField',
    // Hydrated refs carry their label; a bare id (a list row's raw value)
    // only says one is set.
    format: (value) => {
      if (typeof value === 'string' && value !== '') return 'Linked'
      if (value === null || typeof value !== 'object' || !('id' in value)) return EMPTY
      const ref = value as RecordsRefValue
      if (ref.hidden) return 'Hidden'
      if (ref.missing) return 'Deleted'
      return ref.label || EMPTY
    }
  }
}

/** The files of an attachments value (anything else reads as none). */
export function recordsAttachmentList(value: unknown): RecordsAttachmentValue[] {
  return asArray(value).filter((v): v is RecordsAttachmentValue =>
    v !== null && typeof v === 'object' && 'id' in v && 'url' in v)
}

// The image types the server serves inline (others download), so the only
// ones a thumbnail or cover can show.
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'])

/** Whether a file can show as an image (thumbnail, card cover). */
export function recordsIsImage(file: Pick<RecordsAttachmentValue, 'mime'>): boolean {
  return INLINE_IMAGE_TYPES.has(file.mime)
}

/** A file size for people: 820 B, 14 KB, 3.2 MB. */
export function recordsFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Unknown kinds (stale orphan fields) fall back to plain-text display. */
export function recordsRendererFor(kind: string): RecordsKindRenderer {
  return RECORDS_FIELD_KINDS[kind as RecordsFieldKind] ?? { icon: 'i-lucide-type', format: formatText }
}

/**
 * The icon that stands for a field where its label isn't shown: its own,
 * else the status, parent or children icon, else its kind's.
 */
export function recordsFieldIcon(field: Pick<RecordsFieldSetting, 'kind'> & Partial<Pick<RecordsFieldSetting, 'icon' | 'column' | 'hierarchy'>>): string {
  if (field.icon) return field.icon
  if (field.column === 'status') return 'i-lucide-circle-dot'
  if (field.hierarchy === 'children') return 'i-lucide-list-tree'
  if (field.hierarchy === 'parent') return 'i-lucide-corner-left-up'
  return recordsRendererFor(field.kind).icon
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
