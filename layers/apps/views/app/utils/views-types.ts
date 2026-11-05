// Client-side shapes of the views API responses. Dates arrive as ISO
// strings over JSON; the server DTOs are the source of truth for meaning.

export type ViewType = 'kanban' | 'table'
export type ViewsVisibility = 'private' | 'shared' | 'org'
export type ViewsAccessLevel = 'view' | 'edit' | 'owner'

export type ViewsConnectionDisplay = 'names' | 'count' | 'progress'

/** The card layout a view renders, resolved server-side. */
export interface ViewsCardLayout {
  fields: string[]
  connections: Record<string, ViewsConnectionDisplay>
  /** The view stores its own layout instead of its type's default. */
  custom: boolean
}

export interface ViewsColumnDef {
  key: string
  label: string
  color?: string
}

export interface ViewsDefinition {
  /** Field-grouped kanban: the grouping field's key. XOR with `columns`. */
  groupField?: string
  /** Custom-column kanban: the board's own columns. XOR with `groupField`. */
  columns?: ViewsColumnDef[]
  /**
   * Field keys shown on cards / as table columns (name is always shown).
   * Absent = the record type's default card layout.
   */
  cardFields?: string[]
  /** Per connection card field: names, a count, or done-progress. Only with cardFields. */
  cardConnections?: Record<string, ViewsConnectionDisplay>
  /** Saved shared filters, in the records list engine's filter shape. */
  filters?: Record<string, unknown>
  sort?: { field: string, dir: 'asc' | 'desc' }
}

export interface ViewSummary {
  id: string
  name: string
  icon: string | null
  recordTypeKey: string
  viewType: ViewType
  visibility: ViewsVisibility
  ownerId: string
  ownerName: string
  accessLevel: ViewsAccessLevel
  createdAt: string
  updatedAt: string
}

export interface ViewDetail extends ViewSummary {
  definition: ViewsDefinition
  /** The view reached the caller through a share row of their own. */
  sharedWithMe: boolean
}

export interface ViewsPlacement {
  recordId: string
  columnKey: string
  rank: string | null
}

/** A record as served inside a view feed (records list item + board extras). */
export interface ViewsBoardItem {
  id: string
  name: string
  status: string | null
  createdAt: string
  updatedAt: string
  assignedTo: string[]
  /** Raw jsonb map — values for jsonb-stored fields only. */
  data: Record<string, unknown>
  /** Current values of the grouping field (field-grouped boards only). */
  groupValues?: string[]
  /**
   * Values for card fields stored outside the record row — multi-selects,
   * tags, links, user references, connections, channels. Carried only for
   * the keys the view shows.
   */
  fields?: Record<string, unknown>
  /** Per connection card field shown as count or progress: linked and done totals. */
  progress?: Record<string, { total: number, done: number }>
}

export interface ViewRecords {
  items: ViewsBoardItem[]
  total: number
  truncated: boolean
  placements: ViewsPlacement[]
  /** Connection-grouped boards: the target records that make the columns. */
  groupColumns?: Array<{ key: string, label: string }>
  card: ViewsCardLayout
  groupFieldMissing: boolean
}

export interface ViewsShareEntry {
  userId: string
  level: 'view' | 'edit'
  displayName: string
  email: string
  avatar: string
}

/** The "No value" kanban column key ('' server-side). */
export const VIEWS_NO_VALUE_COLUMN = ''

/** How a drag between field-grouped columns changes the record (see placements.ts). */
export type ViewsDragMode = 'move' | 'add'

export function viewsDragMode(field: { kind: string }): ViewsDragMode {
  return field.kind === 'key_select' || field.kind === 'user_select' ? 'move' : 'add'
}

/** Kinds a kanban can group by (mirrors the server's VIEWS_GROUPABLE_KINDS). */
export const VIEWS_GROUPABLE_KINDS = new Set(['key_select', 'multi_select', 'user_select', 'tags', 'connection'])
