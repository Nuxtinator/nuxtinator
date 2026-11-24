// Client-side shapes of the views API responses. Dates arrive as ISO
// strings over JSON; the server DTOs are the source of truth for meaning.
import type { RecordsFilterGroup } from '#records/client'

export type ViewsLayout = 'kanban' | 'table' | 'list' | 'calendar'
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
  /** The type's cover field: its first image tops each board card. */
  cover?: string
  /** Card fields that stay on the card when empty, so they can be set from it. */
  showEmpty?: string[]
}

export interface ViewsColumnDef {
  key: string
  label: string
  color?: string
}

/** Kinds a view's own field can be. */
export type ViewsFieldKind = 'text' | 'textarea' | 'number' | 'boolean' | 'date' | 'key_select'
  | 'multi_select' | 'tags' | 'link' | 'user_select' | 'attachments'

/** One of a view's own fields, as its definition stores it. */
export interface ViewsFieldDef {
  key: string
  label: string
  kind: ViewsFieldKind
  options?: Record<string, { label: string, color?: string }>
  multiple?: true
}

/** What a view decides for all its tabs. */
export interface ViewsViewDefinition {
  /** Base filter every tab narrows further. */
  filter?: RecordsFilterGroup
  /** Tabs show only the records added to the view by hand. */
  picked?: true
  /** The view's own fields: values shared by everyone who opens the view. */
  fields?: ViewsFieldDef[]
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
  /** Card fields that stay on the card when empty, so they can be set from it. Only with cardFields. */
  cardShowEmpty?: string[]
  /** This tab's filter, ANDed with the view's base filter. */
  filter?: RecordsFilterGroup
  sort?: { field: string, dir: 'asc' | 'desc' }
  /** Calendar: the date field that places each record on a day. */
  dateField?: string
  /** Calendar: a second date field; a record spans from `dateField` to it. */
  endField?: string
}

export interface ViewsTab {
  id: string
  name: string
  layout: ViewsLayout
  position: string
  definition: ViewsDefinition
  /** On a built-in that stands for a record: the sort that record keeps in place of the tab's, or null. */
  recordSort?: { field: string, dir: 'asc' | 'desc' } | null
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
  /** The teams a view with visibility 'teams' opens to. */
  teams: Array<{ id: string, name: string, icon: string | null, image: string | null, archived: boolean }>
  /** Declared in code: nobody owns or changes it; copying it makes one of your own. */
  builtIn: boolean
  createdAt: string
  updatedAt: string
}

export interface ViewDetail extends Omit<ViewSummary, 'layout' | 'tabCount' | 'teams'> {
  definition: ViewsViewDefinition
  /** Per grouping field: the positions of the columns someone placed (a card's board: that card's). */
  columnOrder: Record<string, Record<string, string>>
  tabs: ViewsTab[]
  /** The view reached the caller through a share row of their own. */
  sharedWithMe: boolean
  /** The teams a view with visibility 'teams' opens to, each at its level. */
  teams: Array<{ id: string, name: string, icon: string | null, image: string | null, archived: boolean, level: ViewsShareLevel }>
  /** Everyone's level on an org-wide view. */
  orgLevel: ViewsShareLevel
  /** Records created on this hand-picked view and on no other — deleted with it. */
  ownCardCount: number
  /** The record a built-in view stands for (a task's subtasks board), else null. */
  recordId: string | null
  /** That record's type, which can differ from the type the view shows (a deliverable's tasks). */
  recordType: string | null
  /** The views above a built-in that stands for a record, outermost first. */
  trail: Array<{ id: string, name: string }>
  /** The caller can change the sort, the column order and the order set by dragging on the board of the record a built-in stands for. */
  canOrder?: boolean
}

/** The built-in view that shows one task's subtasks as a board. */
export const VIEWS_SUBTASKS_KEY = 'subtasks'

/** Whether `field` holds the records that open as their record's subtasks board. */
export function viewsIsSubtasksField(field: { hierarchy?: 'parent' | 'children' | null, target?: string | null }): boolean {
  return field.hierarchy === 'children' && !!field.target
}

const VIEW_ID_RE = /^(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|builtin\.[A-Za-z0-9.-]{1,140})$/i

/** Whether `value` has the shape of a view id (a stored view's uuid or `builtin.…`). */
export function viewsIsViewId(value: unknown): value is string {
  return typeof value === 'string' && VIEW_ID_RE.test(value)
}

/** The id of the view showing what sits under record `recordId`. */
export function viewsSubtasksViewId(recordId: string): string {
  return `builtin.${VIEWS_SUBTASKS_KEY}.${recordId}`
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
  /** Values of the view's own fields, keyed by field key (views with fields only). */
  viewValues?: Record<string, unknown>
  /** Added on screen and not saved yet: shown dimmed, and not opened, dragged or edited until it is. */
  pending?: true
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
  /** Calendars: the date field placing records was deleted. */
  dateFieldMissing?: boolean
  /** Calendars: the first records with no date, and how many there are. */
  unscheduled?: { items: ViewsBoardItem[], total: number }
  /** A board in the order set under a record: whether anyone has placed a card in it yet. */
  ordered?: boolean
  /** A board with more records than it shows: no cards are sent, and a filter narrows it. */
  tooMany?: boolean
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

export function viewsDragMode(field: { kind: string, hierarchy?: 'parent' | 'children' | null }): ViewsDragMode {
  return field.kind === 'key_select' || field.kind === 'user_select' || field.hierarchy === 'parent' ? 'move' : 'add'
}

export const VIEWS_LAYOUT_META: Record<ViewsLayout, { label: string, icon: string }> = {
  kanban: { label: 'Board', icon: 'i-lucide-kanban' },
  list: { label: 'List', icon: 'i-lucide-list-checks' },
  table: { label: 'Table', icon: 'i-lucide-table' },
  calendar: { label: 'Calendar', icon: 'i-lucide-calendar-days' }
}

/** Every layout, in the order pickers list them. */
export const VIEWS_LAYOUT_ORDER: ViewsLayout[] = ['kanban', 'list', 'table', 'calendar']

/** Kinds a board or list can group by (mirrors the server's VIEWS_GROUPABLE_KINDS). */
export const VIEWS_GROUPABLE_KINDS = new Set(['key_select', 'multi_select', 'user_select', 'tags', 'connection'])
