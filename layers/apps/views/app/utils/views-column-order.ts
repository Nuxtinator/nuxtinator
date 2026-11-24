// A view's column order for one grouping field: the fractional-indexing key
// of each column someone placed. Shared by the server, which stores it, and
// the board, which shows a drag before the save comes back.
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing'

/** Column key → position, for the columns someone placed. */
export type ViewsColumnPositions = Record<string, string>

/** The "No value" column's key; it stays first and has no position. */
const PINNED_COLUMN = ''

/**
 * `columns` in the view's order: the "No value" column, then the placed
 * columns by position, then the rest as they came. Positions of columns that
 * aren't there (a deleted option) are ignored.
 */
export function viewsOrderColumns<T extends { key: string }>(columns: T[], positions: ViewsColumnPositions | undefined): T[] {
  if (!positions || Object.keys(positions).length === 0) return columns
  const pinned: T[] = []
  const placed: Array<{ column: T, position: string, index: number }> = []
  const rest: T[] = []
  columns.forEach((column, index) => {
    const position = positions[column.key]
    if (column.key === PINNED_COLUMN) pinned.push(column)
    else if (position !== undefined) placed.push({ column, position, index })
    else rest.push(column)
  })
  placed.sort((a, b) => a.position < b.position ? -1 : a.position > b.position ? 1 : a.index - b.index)
  return [...pinned, ...placed.map(p => p.column), ...rest]
}

/**
 * The positions after `key` was dropped where it sits in `order` (every
 * column's key as shown after the drop, "No value" left out). Between two
 * placed neighbours, or at a placed edge, only `key` gets a new position.
 * Otherwise every column in `order` is placed, in that order, and `replaced`
 * says the positions of columns not in `order` are gone.
 */
export function viewsPlaceColumn(
  positions: ViewsColumnPositions,
  order: string[],
  key: string
): { positions: ViewsColumnPositions, replaced: boolean } {
  const index = order.indexOf(key)
  const prev = index > 0 ? order[index - 1]! : null
  const next = index >= 0 && index < order.length - 1 ? order[index + 1]! : null
  const prevPosition = prev !== null ? positions[prev] ?? null : null
  const nextPosition = next !== null ? positions[next] ?? null : null
  const edgesPlaced = (prev === null || prevPosition !== null) && (next === null || nextPosition !== null)
  if (index >= 0 && edgesPlaced && (prevPosition === null || nextPosition === null || prevPosition < nextPosition)) {
    return { positions: { ...positions, [key]: generateKeyBetween(prevPosition, nextPosition) }, replaced: false }
  }
  const keys = generateNKeysBetween(null, null, order.length)
  return { positions: Object.fromEntries(order.map((k, i) => [k, keys[i]!])), replaced: true }
}

/** Positions that put `keys` first, in that order. */
export function viewsColumnPositionsFor(keys: string[]): ViewsColumnPositions {
  const positions = generateNKeysBetween(null, null, keys.length)
  return Object.fromEntries(keys.map((k, i) => [k, positions[i]!]))
}

/**
 * `order` with `fromKey` moved next to `toKey` (after it when `after`). A
 * drop on the "No value" column puts it first, since nothing goes before that.
 */
export function viewsMoveColumnKey(order: string[], fromKey: string, toKey: string, after: boolean): string[] | null {
  if (fromKey === toKey || !order.includes(fromKey)) return null
  const next = order.filter(k => k !== fromKey)
  if (toKey === PINNED_COLUMN) return [fromKey, ...next]
  const anchor = next.indexOf(toKey)
  if (anchor < 0) return null
  next.splice(after ? anchor + 1 : anchor, 0, fromKey)
  return next
}
