// Client-side shapes of the workflows API responses. Dates arrive as ISO
// strings over JSON; the server DTOs are the source of truth for meaning.

export type WorkflowsViewType = 'kanban' | 'table'
export type WorkflowsVisibility = 'private' | 'shared' | 'org'
export type WorkflowsAccessLevel = 'view' | 'edit' | 'owner'

export interface WorkflowsColumnDef {
  key: string
  label: string
  color?: string
}

export interface WorkflowsDefinition {
  /** Field-grouped kanban: the grouping field's key. XOR with `columns`. */
  groupField?: string
  /** Custom-column kanban: the board's own columns. XOR with `groupField`. */
  columns?: WorkflowsColumnDef[]
  /** Field keys shown on cards / as table columns (name is always shown). */
  cardFields?: string[]
  /** Saved shared filters, in the CRM list engine's filter shape. */
  filters?: Record<string, unknown>
  sort?: { field: string, dir: 'asc' | 'desc' }
}

export interface WorkflowsViewSummary {
  id: string
  name: string
  icon: string | null
  recordTypeKey: string
  viewType: WorkflowsViewType
  visibility: WorkflowsVisibility
  ownerId: string
  ownerName: string
  accessLevel: WorkflowsAccessLevel
  createdAt: string
  updatedAt: string
}

export interface WorkflowsViewDetail extends WorkflowsViewSummary {
  definition: WorkflowsDefinition
}

export interface WorkflowsPlacement {
  recordId: string
  columnKey: string
  rank: string | null
}

/** A record as served inside a view feed (CRM list item + board extras). */
export interface WorkflowsBoardItem {
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
}

export interface WorkflowsViewRecords {
  items: WorkflowsBoardItem[]
  total: number
  truncated: boolean
  placements: WorkflowsPlacement[]
  groupFieldMissing: boolean
}

export interface WorkflowsShareEntry {
  userId: string
  level: 'view' | 'edit'
  displayName: string
  email: string
  avatar: string
}

/** The "No value" kanban column key ('' server-side). */
export const WORKFLOWS_NO_VALUE_COLUMN = ''
