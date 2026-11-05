export type PostType = 'task' | 'feature' | 'bug' | 'artifact' | 'feedback'

export interface KanbanCardModel {
  id: string
  project_id: string
  swimlane_id: string
  column_id: string | null
  title: string
  post_type: PostType
  description: string | null
  assignee: string | null
  created_at: string
  start_date: string | null
  due_date: string | null
  priority: string | null
  is_done: boolean
  testing_results: string | null
  post_meta: Record<string, any>
}

export interface KanbanColumnModel {
  id: string
  name: string
  position: number
  is_collapsed: boolean
  post_meta: Record<string, any>
}

export interface KanbanSwimlaneModel {
  id: string
  project_id: string
  name: string
  is_default: boolean
  position: number
}

export interface KanbanProjectModel {
  id: string
  name: string
  description: string | null
  is_expanded: boolean
  allowed_origins: string[]
  post_meta: Record<string, any>
  // 'org' or 'teams'; `teams` lists the teams a 'teams' project is limited to.
  visibility: string
  teams: { id: string, name: string, archived: boolean }[]
}
