import type { ColumnType, Generated } from 'kysely'

export type FeedbackPostType = 'task' | 'feature' | 'bug' | 'artifact' | 'feedback'
export type FeedbackAttachmentKind = 'screenshot' | 'attachment'
export type FeedbackProjectVisibility = 'org' | 'teams'

export interface ProjectsTable {
  id: Generated<string>
  name: string
  description: string | null
  is_expanded: Generated<boolean>
  allowed_origins: Generated<string[]>
  post_meta: Generated<Record<string, any>>
  visibility: Generated<FeedbackProjectVisibility>
  created_at: ColumnType<Date, string | Date | undefined, string | Date>
  updated_at: ColumnType<Date, string | Date | undefined, string | Date>
}

export interface FeedbackProjectTeamsTable {
  container_id: string
  group_id: string
  created_at: ColumnType<Date, string | Date | undefined, string | Date>
}

export interface FeedbackAuthCodesTable {
  id: Generated<string>
  code_hash: string
  user_id: string
  project_id: string
  redirect_origin: string
  code_challenge: string
  token_ciphertext: string
  expires: ColumnType<Date, string | Date, string | Date>
  created_at: ColumnType<Date, string | Date | undefined, string | Date>
}

export interface ColumnsTable {
  id: Generated<string>
  name: string
  position: number
  is_collapsed: Generated<boolean>
  post_meta: Generated<Record<string, any>>
  created_at: ColumnType<Date, string | Date | undefined, string | Date>
  updated_at: ColumnType<Date, string | Date | undefined, string | Date>
}

export interface SwimlanesTable {
  id: Generated<string>
  project_id: string
  name: string
  is_default: Generated<boolean>
  position: Generated<number>
  post_meta: Generated<Record<string, any>>
  created_at: ColumnType<Date, string | Date | undefined, string | Date>
  updated_at: ColumnType<Date, string | Date | undefined, string | Date>
}

export interface CardsTable {
  id: Generated<string>
  project_id: string
  swimlane_id: string
  column_id: string | null
  title: Generated<string>
  post_type: Generated<FeedbackPostType>
  description: string | null
  assignee: string | null
  start_date: ColumnType<Date | string | null, string | Date | null | undefined, string | Date | null>
  due_date: ColumnType<Date | string | null, string | Date | null | undefined, string | Date | null>
  priority: string | null
  is_done: Generated<boolean>
  testing_results: string | null
  post_meta: Generated<Record<string, any>>
  last_moved_at: ColumnType<Date, string | Date | undefined, string | Date>
  created_at: ColumnType<Date, string | Date | undefined, string | Date>
  updated_at: ColumnType<Date, string | Date | undefined, string | Date>
}

export interface CardColumnHistoryTable {
  id: Generated<string>
  card_id: string
  column_id: string | null
  moved_at: ColumnType<Date, string | Date | undefined, string | Date>
}

export interface FeedbackAttachmentsTable {
  id: Generated<string>
  card_id: string
  kind: FeedbackAttachmentKind
  storage_key: string
  filename: string
  mime_type: string
  size_bytes: number
  created_at: ColumnType<Date, string | Date | undefined, string | Date>
}

declare global {
  interface NuxtinatorDatabaseTables {
    projects: ProjectsTable
    columns: ColumnsTable
    swimlanes: SwimlanesTable
    cards: CardsTable
    card_column_history: CardColumnHistoryTable
    feedback_attachments: FeedbackAttachmentsTable
    feedback_auth_codes: FeedbackAuthCodesTable
    feedback_project_teams: FeedbackProjectTeamsTable
  }
}
