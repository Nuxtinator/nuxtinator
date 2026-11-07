// The columns of a board, or the sections of a list, with their cards in
// order: manual ranks first, feed order for the rest.
//
// - Own columns: columns from the definition, membership from placements. A
//   record with no placement, or one pointing at a removed column, sits in
//   the first column of a hand-picked view, or in a leading "No column" lane
//   of a view that shows every matching record, so nothing silently
//   disappears.
// - Grouped by a field: the field's options (selects), the users or tags
//   present on records (plus tag columns added this session), or the target
//   type's records (connections), after a leading "No value" column (status
//   has none). A record with several values appears in each matching column.
// - An ungrouped list: one unnamed section.
import type { RecordsFieldSetting } from '#records/client'
import type { ViewsBoardItem, ViewsDefinition, ViewRecords } from '../utils/views-types'
import { VIEWS_NO_VALUE_COLUMN } from '../utils/views-types'

export interface ViewsColumn {
  key: string
  label: string
  color?: string
  cards: ViewsBoardItem[]
}

export interface ViewsColumnsSource {
  definition: ViewsDefinition
  /** The view holds hand-picked records (its own-column boards have no "No column" lane). */
  picked?: boolean
  records: ViewRecords
  fields: RecordsFieldSetting[]
  /** Tag columns added this session, shown before any card carries them. */
  pendingTagColumns?: string[]
}

export function useViewsColumns(source: () => ViewsColumnsSource) {
  const { byId: usersById } = useRecordsUsers()

  return computed<ViewsColumn[]>(() => {
    const src = source()
    const pendingTags = src.pendingTagColumns ?? []
    const groupField = src.definition.groupField
      ? src.fields.find(f => f.key === src.definition.groupField) ?? null
      : null

    const ranks = new Map<string, string>()
    for (const p of src.records.placements) {
      if (p.rank) ranks.set(`${p.recordId}:${p.columnKey}`, p.rank)
    }
    function orderCards(cards: ViewsBoardItem[], columnKey: string): ViewsBoardItem[] {
      const ranked: Array<{ card: ViewsBoardItem, rank: string }> = []
      const rest: ViewsBoardItem[] = []
      for (const card of cards) {
        const rank = ranks.get(`${card.id}:${columnKey}`)
        if (rank) ranked.push({ card, rank })
        else rest.push(card)
      }
      ranked.sort((a, b) => a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0)
      return [...ranked.map(r => r.card), ...rest]
    }

    const items = src.records.items

    if (src.definition.columns) {
      const defs: Array<{ key: string, label: string, color?: string }> = src.picked
        ? src.definition.columns
        : [{ key: VIEWS_NO_VALUE_COLUMN, label: 'No column' }, ...src.definition.columns]
      const byColumn = new Map<string, ViewsBoardItem[]>(defs.map(d => [d.key, []]))
      const columnOf = new Map<string, string>()
      for (const p of src.records.placements) columnOf.set(p.recordId, p.columnKey)
      const fallback = defs[0]?.key
      for (const item of items) {
        const key = columnOf.get(item.id)
        const target = key !== undefined && byColumn.has(key) ? key : fallback
        if (target !== undefined) byColumn.get(target)!.push(item)
      }
      return defs.map(d => ({
        key: d.key,
        label: d.label,
        color: d.color,
        cards: orderCards(byColumn.get(d.key) ?? [], d.key)
      }))
    }

    const field = groupField
    if (!field) {
      // An ungrouped list: one unnamed section, ordered by hand.
      return [{ key: VIEWS_NO_VALUE_COLUMN, label: '', cards: orderCards(items, VIEWS_NO_VALUE_COLUMN) }]
    }

    const byColumn = new Map<string, ViewsBoardItem[]>()
    const add = (key: string, item: ViewsBoardItem) => {
      if (!byColumn.has(key)) byColumn.set(key, [])
      byColumn.get(key)!.push(item)
    }
    for (const item of items) {
      const values = item.groupValues ?? []
      if (values.length === 0) add(VIEWS_NO_VALUE_COLUMN, item)
      for (const value of values) add(value, item)
    }

    // Every record has a status, so a status board has no "No value" column.
    const defs: Array<{ key: string, label: string, color?: string }> = field.column === 'status'
      ? []
      : [{ key: VIEWS_NO_VALUE_COLUMN, label: `No ${field.label.toLowerCase()}` }]
    if (field.kind === 'connection') {
      for (const col of src.records.groupColumns ?? []) defs.push({ key: col.key, label: col.label })
      // A card may point at a target the caller can't list (or past the cap).
      for (const key of byColumn.keys()) {
        if (key !== VIEWS_NO_VALUE_COLUMN && !defs.some(d => d.key === key)) defs.push({ key, label: 'Linked record' })
      }
    } else if (field.kind === 'tags') {
      const seen = new Set<string>()
      for (const [key, option] of Object.entries(field.options ?? {})) {
        if (option.deleted) continue
        seen.add(key)
        defs.push({ key, label: option.label, color: option.color })
      }
      const present = [...byColumn.keys()].filter(k => k !== VIEWS_NO_VALUE_COLUMN && !seen.has(k)).sort((a, b) => a.localeCompare(b))
      for (const tag of [...present, ...pendingTags.filter(t => !present.includes(t) && !seen.has(t))]) {
        defs.push({ key: tag, label: tag })
      }
    } else if (field.kind === 'user_select') {
      // User columns exist where cards are — there is no fixed option set.
      const present = [...byColumn.keys()].filter(k => k !== VIEWS_NO_VALUE_COLUMN).sort((a, b) => {
        const an = usersById.value.get(a)?.name ?? a
        const bn = usersById.value.get(b)?.name ?? b
        return an.localeCompare(bn)
      })
      for (const id of present) {
        defs.push({ key: id, label: usersById.value.get(id)?.name ?? 'Unknown user' })
      }
    } else {
      for (const [key, option] of Object.entries(field.options ?? {})) {
        if (option.deleted) continue
        defs.push({ key, label: option.label, color: option.color })
      }
      // Values pointing at deleted/unknown options still hold cards — surface
      // them as their raw key rather than dropping the cards.
      for (const key of byColumn.keys()) {
        if (key !== VIEWS_NO_VALUE_COLUMN && !defs.some(d => d.key === key)) {
          defs.push({ key, label: key })
        }
      }
    }

    return defs.map(d => ({
      key: d.key,
      label: d.label,
      color: d.color,
      cards: orderCards(byColumn.get(d.key) ?? [], d.key)
    }))
  })
}
