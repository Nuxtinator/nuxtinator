// The values a card or list row shows for its card fields, in the order the
// tab chose. Values come from the record row (status, timestamps, jsonb
// fields), from the grouping values, from the side-table values the feed
// attaches for the chosen keys, or from the view's own field values — so any
// field of the type or the view can be shown. Files show as a count. User
// fields carry ids to render as people; connection fields shown as a count
// or progress carry the totals.
import type { RecordsFieldSetting } from '#records/client'
import type { ViewsBoardItem, ViewsConnectionDisplay } from '../utils/views-types'

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
  text: string
  /** Set for user fields — rendered as people in place of the text. */
  userIds?: string[]
  /** Set for connection fields shown as progress — rendered as a bar. */
  progress?: { done: number, total: number }
}

const INTRINSIC_DEFS: Record<string, Pick<RecordsFieldSetting, 'key' | 'kind' | 'label'>> = {
  created_at: { key: 'created_at', kind: 'datetime', label: 'Created' },
  updated_at: { key: 'updated_at', kind: 'datetime', label: 'Updated' }
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
    const out: ViewsCardValue[] = []
    for (const key of cardFields) {
      if (key === 'name' || key === coverKey) continue
      const intrinsic = INTRINSIC_DEFS[key]
      if (intrinsic) {
        const raw = key === 'created_at' ? item.createdAt : item.updatedAt
        const text = formatRecordsValue(raw, intrinsic as RecordsFieldSetting)
        if (text && text !== '—') out.push({ key, label: intrinsic.label, text })
        continue
      }
      const field = fieldMap.get(key)
        ?? (key === 'status' ? fields.find(f => f.column === 'status') : undefined)
      if (!field) continue
      let raw: unknown = null
      if (viewsIsViewField(field)) raw = item.viewValues?.[field.key] ?? null
      else if (field.column === 'status' || key === 'status') raw = item.status
      else if (viewsFieldStorage(field) === 'jsonb') raw = item.data[field.key]
      else if (item.fields && field.key in item.fields) raw = item.fields[field.key]
      else if (field.key === groupFieldKey) raw = item.groupValues

      const display = cardConnections?.[field.key]
      const progress = item.progress?.[field.key]
      if (field.kind === 'connection' && progress && (display === 'count' || display === 'progress')) {
        if (progress.total === 0) continue
        if (display === 'count') out.push({ key, label: field.label, text: String(progress.total) })
        else out.push({ key, label: field.label, text: `${progress.done}/${progress.total}`, progress })
        continue
      }

      if (field.kind === 'attachments') {
        const count = recordsAttachmentList(raw).length
        if (count > 0) out.push({ key, label: field.label, text: String(count) })
        continue
      }

      if (field.kind === 'user_select') {
        const userIds = userIdsOf(raw)
        if (userIds.length > 0) out.push({ key, label: field.label, text: '', userIds })
        continue
      }
      const text = formatRecordsValue(raw, field, { userName })
      if (text && text !== '—') out.push({ key, label: field.label, text })
    }
    return out
  })
}
