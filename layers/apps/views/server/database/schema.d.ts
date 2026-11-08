// Adds the views tables to the host schema by merging into core's global
// `NuxtinatorDatabaseTables` registry (resolution-independent — see core's
// server/database/schema.ts).
import type { ColumnType, Generated } from 'kysely'

// Code-owned vocabularies (mirrored by CHECK constraints in the migrations).
export type ViewsLayout = 'kanban' | 'table' | 'list'
export type ViewsVisibility = 'private' | 'org' | 'teams'
export type ViewsShareLevel = 'view' | 'edit'

export interface ViewsViewsTable {
  id: Generated<string>
  name: string
  icon: string | null
  // Key into CRM's type registry — types can be code manifests, so no FK.
  record_type_key: string
  visibility: Generated<ViewsVisibility>
  // Everyone's level on an org-wide view; null = 'view'.
  org_level: 'edit' | null
  owner_id: string
  // Only explicit choices (base filter, hand-picked records); shape
  // validated by server/utils/views.ts, defaults live in code.
  definition: Generated<Record<string, unknown>>
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>
}

export interface ViewSharesTable {
  view_id: string
  user_id: string
  // 'view' opens the view; 'edit' also edits its tabs. On a hand-picked view
  // the level also applies to its cards.
  level: ViewsShareLevel
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
}

export interface ViewTabsTable {
  id: Generated<string>
  view_id: string
  name: string
  layout: ViewsLayout
  // Fractional index; tabs order by it.
  position: string
  // Only explicit choices (grouping/columns, card fields, filter, sort).
  definition: Generated<Record<string, unknown>>
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>
}

// The teams a view with visibility 'teams' opens to.
export interface ViewTeamsTable {
  container_id: string
  group_id: string
  // The team's level; null = 'view'.
  level: 'edit' | null
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
}

// The records added by hand to a view whose tabs show only those.
export interface ViewItemsTable {
  view_id: string
  record_id: string
  // The record was created on this view.
  created_here: Generated<boolean>
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
}

export interface ViewCardsTable {
  view_id: string
  tab_id: string
  record_id: string
  // Custom column key on boards with their own columns; grouping value on
  // field-grouped boards and lists ('' = the "No value" column, and every
  // row of an ungrouped list).
  column_key: Generated<string>
  // Fractional index; null = no manual position yet.
  rank: string | null
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
}

// A value of one of a view's own fields on one record (see views_003).
export interface ViewValuesTable {
  view_id: string
  record_id: string
  field_key: string
  value: unknown
  updated_by: string | null
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>
}

declare global {
  interface NuxtinatorDatabaseTables {
    views_values: ViewValuesTable
    views_definitions: ViewsViewsTable
    views_shares: ViewSharesTable
    views_teams: ViewTeamsTable
    views_tabs: ViewTabsTable
    views_items: ViewItemsTable
    views_cards: ViewCardsTable
  }
}

export {}
