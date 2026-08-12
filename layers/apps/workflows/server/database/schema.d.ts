// Adds the workflows tables to the host schema by merging into core's global
// `NuxtinatorDatabaseTables` registry (resolution-independent — see core's
// server/database/schema.ts).
import type { ColumnType, Generated } from 'kysely'

// Code-owned vocabularies (mirrored by CHECK constraints in the migrations).
export type WorkflowsViewType = 'kanban' | 'table'
export type WorkflowsVisibility = 'private' | 'shared' | 'org'
export type WorkflowsShareLevel = 'view' | 'edit'

export interface WorkflowsViewsTable {
  id: Generated<string>
  name: string
  icon: string | null
  // Key into CRM's type registry — types can be code manifests, so no FK.
  record_type_key: string
  view_type: WorkflowsViewType
  visibility: Generated<WorkflowsVisibility>
  owner_id: string
  // Only explicit choices (grouping/columns, cardFields, filters, sort);
  // shape validated by server/utils/views.ts, defaults live in code.
  definition: Generated<Record<string, unknown>>
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>
}

export interface WorkflowsViewSharesTable {
  view_id: string
  user_id: string
  // 'view' opens the view and drags cards; 'edit' also changes the view
  // definition. Neither widens CRM record access.
  level: Generated<WorkflowsShareLevel>
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
}

export interface WorkflowsViewCardsTable {
  view_id: string
  record_id: string
  // Custom column key on container boards; grouping-field option key on
  // field boards ('' = the "No value" column).
  column_key: Generated<string>
  // Fractional index; null = no manual position yet.
  rank: string | null
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
}

declare global {
  interface NuxtinatorDatabaseTables {
    workflows_views: WorkflowsViewsTable
    workflows_view_shares: WorkflowsViewSharesTable
    workflows_view_cards: WorkflowsViewCardsTable
  }
}

export {}
