// The values a card or list row shows for its card fields, in the order the
// tab chose. Values come from the record row (status, timestamps, jsonb
// fields), from the grouping values, from the side-table values the feed
// attaches for the chosen keys, or from the view's own field values — so any
// field of the type or the view can be shown. Each value carries the icon
// that stands for its field. Files show as a count. User
// fields carry ids to render as people; connection fields shown as a count
// or progress carry the totals, and otherwise the names of the linked
// records the viewer can open. Refs show their resolved label. The due date
// of an open record is marked when it is near or past.
import type { RecordsFieldSetting } from '#records/client'
import { viewsIsSubtasksField, type ViewsBoardItem, type ViewsConnectionDisplay } from '../utils/views-types'

export interface ViewsCardValueSource {
  item: ViewsBoardItem
  fields: RecordsFieldSetting[]
  cardFields: string[]
  /** How each connection card field shows; unlisted ones show names. */
  cardConnections?: Record<string, ViewsConnectionDisplay>
  /** The tab's grouping field key, whose values ride on groupValues. */
  groupFieldKey: string | null
  /** The card's cover field, shown as an image instead of a value. */
  coverKey?: string | null
}

export interface ViewsCardValue {
  key: string
  label: string
  /** Shown in place of the label where space is tight (board cards). */
  icon: string
  text: string
  /** Set for user fields — rendered as people in place of the text. */
  userIds?: string[]
  /** Set for connection fields shown as progress — rendered as a bar. */
  progress?: { done: number, total: number }
  /** Set for a task's subtasks: the value opens the record's own board. */
  drill?: true
  /** Set on an open record's due date: 'error' once past, 'warning' within two days. */
  tone?: 'warning' | 'error'
}

const DUE_SOON_DAYS = 2

function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function dueTone(raw: unknown): 'warning' | 'error' | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined
  const day = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : localDay(new Date(raw))
  const now = new Date()
  if (day < localDay(now)) return 'error'
  const soon = new Date(now)
  soon.setDate(soon.getDate() + DUE_SOON_DAYS)
  return day <= localDay(soon) ? 'warning' : undefined
}

const INTRINSIC_DEFS: Record<string, Pick<RecordsFieldSetting, 'key' | 'kind' | 'label'> & { icon: string }> = {
  created_at: { key: 'created_at', kind: 'datetime', label: 'Created', icon: 'i-lucide-calendar-plus' },
  updated_at: { key: 'updated_at', kind: 'datetime', label: 'Updated', icon: 'i-lucide-history' }
}

function userIdsOf(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean)
  return typeof raw === 'string' && raw !== '' ? [raw] : []
}

export function useViewsCardValues(source: () => ViewsCardValueSource) {
  const { byId } = useRecordsUsers()
  const userName = (id: string) => byId.value.get(id)?.name ?? null

  return computed<ViewsCardValue[]>(() => {
    const { item, fields, cardFields, cardConnections, groupFieldKey, coverKey } = source()
    const fieldMap = new Map(fields.map(f => [f.key, f]))
    const statusField = fields.find(f => f.column === 'status')
    const closed = !!(item.status && statusField?.options?.[item.status]?.closed)
    const out: ViewsCardValue[] = []
    for (const key of cardFields) {
      if (key === 'name' || key === coverKey) continue
      const intrinsic = INTRINSIC_DEFS[key]
      if (intrinsic) {
        const raw = key === 'created_at' ? item.createdAt : item.updatedAt
        const text = formatRecordsValue(raw, intrinsic as RecordsFieldSetting)
        if (text && text !== '—') out.push({ key, label: intrinsic.label, icon: intrinsic.icon, text })
        continue
      }
      const field = fieldMap.get(key)
        ?? (key === 'status' ? fields.find(f => f.column === 'status') : undefined)
      if (!field) continue
      const icon = recordsFieldIcon(field)
      let raw: unknown = null
      if (viewsIsViewField(field)) raw = item.viewValues?.[field.key] ?? null
      else if (field.column === 'status' || key === 'status') raw = item.status
      else if (item.fields && field.key in item.fields) raw = item.fields[field.key]
      else if (viewsFieldStorage(field) === 'jsonb') raw = item.data[field.key]
      else if (field.key === groupFieldKey) raw = item.groupValues

      const display = cardConnections?.[field.key]
      const progress = item.progress?.[field.key]
      if (field.kind === 'connection' && progress && (display === 'count' || display === 'progress')) {
        if (progress.total === 0) continue
        const drill = viewsIsSubtasksField(field) ? { drill: true as const } : {}
        if (display === 'count') out.push({ key, label: field.label, icon, text: String(progress.total), ...drill })
        else out.push({ key, label: field.label, icon, text: `${progress.done}/${progress.total}`, progress, ...drill })
        continue
      }

      if (field.kind === 'connection' && Array.isArray(raw) && raw.length > 0 && raw.every(v => v && typeof v === 'object')) {
        const names = (raw as Array<{ name?: string }>).map(v => v.name ?? '').filter(Boolean)
        if (names.length > 0) out.push({ key, label: field.label, icon, text: names.join(', ') })
        continue
      }

      if (field.kind === 'attachments') {
        const count = recordsAttachmentList(raw).length
        if (count > 0) out.push({ key, label: field.label, icon, text: String(count) })
        continue
      }

      if (field.kind === 'user_select') {
        const userIds = userIdsOf(raw)
        if (userIds.length > 0) out.push({ key, label: field.label, icon, text: '', userIds })
        continue
      }
      const text = formatRecordsValue(raw, field, { userName })
      if (!text || text === '—') continue
      const tone = field.due && !closed ? dueTone(raw) : undefined
      out.push({ key, label: field.label, icon, text, ...(tone ? { tone } : {}) })
    }
    return out
  })
}
