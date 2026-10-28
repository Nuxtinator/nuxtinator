import type { InjectionKey, Ref } from 'vue'
import type { KanbanCardModel } from '../components/kanban/types'

/** Users the board can show on cards (submitter, assignee); `avatar` is '' when unset. */
export interface BoardUser {
  id: string
  display_name: string | null
  avatar: string
}

export const BOARD_USERS_KEY: InjectionKey<Ref<BoardUser[]>> = Symbol('feedback-board-users')

/**
 * Cards in the DOING column carry a workflow phase in post_meta.phase. These
 * are the phases and their display labels; a card with no phase reads as the
 * first one.
 */
export const DOING_COLUMN = 'DOING'

export const PHASES = [
  { value: 'backlog', label: 'Backlog' },
  { value: 'planning', label: 'Planning' },
  { value: 'building', label: 'Building' },
  { value: 'testing', label: 'Testing' }
] as const

export function cardPhase(card: KanbanCardModel): string {
  const p = card.post_meta?.phase
  return typeof p === 'string' && p ? p : 'backlog'
}

export function phaseLabel(value: string | null | undefined): string {
  return PHASES.find(p => p.value === value)?.label ?? 'Backlog'
}

/**
 * The text shown as a card's board headline. An explicit title wins; a feedback
 * card with no title falls back to its primary content — the idea for an idea,
 * the problem for a bug — so the headline tracks that content as it's edited.
 * Anything else with no title reads as "(Untitled)".
 */
export function cardHeadline(card: KanbanCardModel): string {
  const t = card.title?.trim()
  if (t) return t
  if (card.post_type === 'feedback') {
    const pm = card.post_meta || {}
    const primary = pm.feedback_sub_type === 'idea' ? pm.suggested_fix : pm.problem_description
    const s = primary != null ? String(primary).trim() : ''
    if (s) return s
  }
  return '(Untitled)'
}

/**
 * Triage labels a card can carry. The catalog (key → display text → color)
 * lives in code; only the chosen keys persist, in post_meta.labels. Adding or
 * renaming a label is a code change here — never a migration or data backfill.
 */
export const FEEDBACK_LABELS = [
  { value: 'cant-reproduce', label: "Can't reproduce", color: 'amber' },
  { value: 'duplicate', label: 'Duplicate', color: 'violet' },
  { value: 'wont-fix', label: "Won't fix", color: 'gray' },
  { value: 'needs-info', label: 'Needs info', color: 'blue' },
  { value: 'confirmed', label: 'Confirmed', color: 'green' }
] as const

export type FeedbackLabel = (typeof FEEDBACK_LABELS)[number]

export function labelDef(value: string): FeedbackLabel | null {
  return FEEDBACK_LABELS.find(l => l.value === value) ?? null
}

/**
 * The label keys applied to a card, filtered to ones the catalog still knows
 * about (drops keys for labels removed from the catalog).
 */
export function cardLabels(card: KanbanCardModel): string[] {
  const v = card.post_meta?.labels
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && FEEDBACK_LABELS.some(l => l.value === x))
}

/** Feedback sub-types (`post_meta.feedback_sub_type`) with their card pill. */
export const FEEDBACK_TYPES = [
  { value: 'bug', label: 'Bug', icon: 'i-lucide-bug', pillClass: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300' },
  { value: 'idea', label: 'Idea', icon: 'i-lucide-lightbulb', pillClass: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300' }
] as const

export type FeedbackType = (typeof FEEDBACK_TYPES)[number]

export function feedbackType(card: KanbanCardModel): FeedbackType | null {
  if (card.post_type !== 'feedback') return null
  return FEEDBACK_TYPES.find(t => t.value === card.post_meta?.feedback_sub_type) ?? null
}

/**
 * Tailwind classes for a label pill. Full static strings (not interpolated) so
 * the JIT compiler keeps them.
 */
export function labelPillClass(value: string): string {
  switch (labelDef(value)?.color) {
    case 'amber':
      return 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
    case 'violet':
      return 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300'
    case 'blue':
      return 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300'
    case 'green':
      return 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300'
    case 'gray':
    default:
      return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
  }
}

/**
 * Check if a card is overdue.
 */
export function isCardOverdue(
  card: KanbanCardModel,
  columnName: string | undefined
): boolean {
  if (!card?.due_date || columnName === 'DONE' || columnName === 'ARCHIVE') return false
  const t = Date.parse(card.due_date)
  if (Number.isNaN(t)) return false
  return t < Date.now()
}

/**
 * Qualitative rank — lower sorts first.
 * highest/critical=0, high=1, medium=2, low=3, null/unknown=99
 */
function qualRank(q: string | null | undefined): number {
  if (!q) return 99
  switch (q.toLowerCase()) {
    case 'highest':
    case 'critical':
      return 0
    case 'high':
      return 1
    case 'medium':
      return 2
    case 'low':
      return 3
    default:
      return 99
  }
}

/**
 * Sort cards by priority: qualitative rank first, then quantitative desc.
 * Returns a new array (does not mutate input).
 */
export function sortCardsByPriority(cards: KanbanCardModel[]): KanbanCardModel[] {
  if (!cards || cards.length === 0) return cards ?? []
  return [...cards].sort((a, b) => {
    const aQual = a.post_meta?.priority_qualitative ?? a.priority ?? null
    const bQual = b.post_meta?.priority_qualitative ?? b.priority ?? null
    const aRank = qualRank(typeof aQual === 'string' ? aQual : null)
    const bRank = qualRank(typeof bQual === 'string' ? bQual : null)
    if (aRank !== bRank) return aRank - bRank
    const aQuant = Number(a.post_meta?.priority_quantitative) || 0
    const bQuant = Number(b.post_meta?.priority_quantitative) || 0
    return bQuant - aQuant
  })
}

/**
 * Tailwind background class for the priority dot.
 */
export function priorityDotColor(qualitative: string | null | undefined): string {
  if (!qualitative) return ''
  switch (qualitative.toLowerCase()) {
    case 'highest':
    case 'critical':
      return 'bg-red-500'
    case 'high':
      return 'bg-orange-500'
    case 'medium':
      return 'bg-yellow-500'
    case 'low':
      return 'bg-gray-400'
    default:
      return ''
  }
}
