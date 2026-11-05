// Adds the views tables to the host schema by merging into core's global
// `NuxtinatorDatabaseTables` registry (resolution-independent — see core's
// server/database/schema.ts).
import type { ColumnType, Generated } from 'kysely'

// Code-owned vocabularies (mirrored by CHECK constraints in the migrations).
export type ViewsLayout = 'kanban' | 'table' | 'list'
export type ViewsVisibility = 'private' | 'shared' | 'org'
export type ViewsShareLevel = 'view' | 'edit'

export interface ViewsViewsTable {
  id: Generated<string>
  name: string
  icon: string | null
  // Key into CRM's type registry — types can be code manifests, so no FK.
  record_type_key: string
  visibility: Generated<ViewsVisibility>
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
  // 'view' opens the view and drags cards; 'edit' also changes the view
  // definition. Neither widens CRM record access.
  level: Generated<ViewsShareLevel>
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

// The records added by hand to a view whose tabs show only those.
export interface ViewItemsTable {
  view_id: string
  record_id: string
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

declare global {
  interface NuxtinatorDatabaseTables {
    views_definitions: ViewsViewsTable
    views_shares: ViewSharesTable
    views_tabs: ViewTabsTable
    views_items: ViewItemsTable
    views_cards: ViewCardsTable
  }
}

export {}
