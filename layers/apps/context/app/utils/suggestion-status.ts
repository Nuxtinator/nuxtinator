// Display metadata for each suggestion status key. The DB stores only the
// key; labels, icons, and colors resolve here.
import type { ContextSuggestionStatus } from '../../server/database/schema'

export type { ContextSuggestionStatus }

export const CONTEXT_SUGGESTION_STATUSES = {
  pending: { label: 'Pending', icon: 'i-lucide-clock', color: 'warning' },
  approved: { label: 'Approved', icon: 'i-lucide-check', color: 'success' },
  rejected: { label: 'Rejected', icon: 'i-lucide-x', color: 'error' },
  withdrawn: { label: 'Withdrawn', icon: 'i-lucide-undo-2', color: 'neutral' },
  superseded: { label: 'Superseded', icon: 'i-lucide-replace', color: 'neutral' }
} as const satisfies Record<ContextSuggestionStatus, { label: string, icon: string, color: 'warning' | 'success' | 'error' | 'neutral' }>

// One suggestion as the review page receives it.
export interface SuggestionItem {
  id: string
  section_key: string
  section_title: string
  section_exists: boolean
  status: ContextSuggestionStatus
  base_content: string
  proposed_content: string
  current_content: string
  stale: boolean
  decided_by_name: string | null
  decided_at: string | null
  review_note: string | null
}
