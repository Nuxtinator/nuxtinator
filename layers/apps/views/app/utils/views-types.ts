// Client-side shapes of the views API responses. Dates arrive as ISO
// strings over JSON; the server DTOs are the source of truth for meaning.
import type { RecordsFilterGroup } from '#records/client'

export type ViewsLayout = 'kanban' | 'table' | 'list'
export type ViewsVisibility = 'private' | 'org' | 'teams'
export type ViewsAccessLevel = 'view' | 'edit' | 'owner'
export type ViewsShareLevel = 'view' | 'edit'

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

/** What a view decides for all its tabs. */
export interface ViewsViewDefinition {
  /** Base filter every tab narrows further. */
  filter?: RecordsFilterGroup
  /** Tabs show only the records added to the view by hand. */
  picked?: true
}

/** What one tab decides. */
export interface ViewsDefinition {
  /** Board: the grouping field (XOR with `columns`). List: optional sections. */
  groupField?: string
  /** Board of a hand-picked view: its own columns. XOR with `groupField`. */
  columns?: ViewsColumnDef[]
  /**
   * Field keys shown on cards, list rows and as table columns (name is always
   * shown). Absent = the record type's default card layout.
   */
  cardFields?: string[]
  /** Per connection card field: names, a count, or done-progress. Only with cardFields. */
  cardConnections?: Record<string, ViewsConnectionDisplay>
  /** This tab's filter, ANDed with the view's base filter. */
  filter?: RecordsFilterGroup
  sort?: { field: string, dir: 'asc' | 'desc' }
}

export interface ViewsTab {
  id: string
  name: string
  layout: ViewsLayout
  position: string
  definition: ViewsDefinition
}

export interface ViewSummary {
  id: string
  name: string
  icon: string | null
  recordTypeKey: string
  /** The first tab's layout — what opening the view shows. */
  layout: ViewsLayout
  tabCount: number
  visibility: ViewsVisibility
  ownerId: string
  ownerName: string
  accessLevel: ViewsAccessLevel
  createdAt: string
  updatedAt: string
}

export interface ViewDetail extends Omit<ViewSummary, 'layout' | 'tabCount'> {
  definition: ViewsViewDefinition
  tabs: ViewsTab[]
  /** The view reached the caller through a share row of their own. */
  sharedWithMe: boolean
  /** The teams a view with visibility 'teams' opens to, each at its level. */
  teams: Array<{ id: string, name: string, icon: string | null, image: string | null, archived: boolean, level: ViewsShareLevel }>
  /** Everyone's level on an org-wide view. */
  orgLevel: ViewsShareLevel
  /** Records created on this hand-picked view and on no other — deleted with it. */
  ownCardCount: number
}

/**
 * One tab as the renderers see it: the view's identity with the tab's layout
 * and definition.
 */
export interface ViewsTabView {
  id: string
  tabId: string
  recordTypeKey: string
  viewType: ViewsLayout
  definition: ViewsDefinition
  picked: boolean
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
  /** Created on this hand-picked view and on no other: deleting it from the view deletes it. */
  ownCard?: true
}

export interface ViewRecords {
  tabId: string
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

export const VIEWS_LAYOUT_META: Record<ViewsLayout, { label: string, icon: string }> = {
  kanban: { label: 'Board', icon: 'i-lucide-kanban' },
  list: { label: 'List', icon: 'i-lucide-list-checks' },
  table: { label: 'Table', icon: 'i-lucide-table' }
}

/** Kinds a board or list can group by (mirrors the server's VIEWS_GROUPABLE_KINDS). */
export const VIEWS_GROUPABLE_KINDS = new Set(['key_select', 'multi_select', 'user_select', 'tags', 'connection'])
