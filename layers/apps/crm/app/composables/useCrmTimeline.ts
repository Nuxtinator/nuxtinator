// Merged comments + activity pager for one record's timeline. The two
// streams page independently — each keeps its own keyset cursor against
// its endpoint — and entries merge client-side newest-first. Entries older
// than the oldest loaded row of a stream that still has more pages stay
// hidden until `loadOlder` fills the gap, so the merged order never shows
// holes that later pages would have to backfill mid-list.

import type { MaybeRefOrGetter } from 'vue'

/** A comment as served by /api/crm/records/:type/:id/comments. */
export interface CrmCommentItem {
  id: string
  authorId: string | null
  authorName: string
  body: string
  createdAt: string
  editedAt: string | null
  /** Name of the connected app the comment came through; null for the web. */
  viaClient: string | null
}

/** An activity row as served by /api/crm/records/:type/:id/activity. */
export interface CrmActivityItem {
  id: string
  action: string
  fieldKey: string | null
  oldValue: unknown
  newValue: unknown
  note: string | null
  actorUserId: string | null
  actorName: string
  /** Name of the connected app the change came through; null for the web. */
  viaClient: string | null
  createdAt: string
}

export type CrmTimelineEntry
  = | { kind: 'comment', id: string, createdAt: string, comment: CrmCommentItem }
    | { kind: 'activity', id: string, createdAt: string, activity: CrmActivityItem }

interface TimelinePage<T> {
  items: T[]
  nextCursor: string | null
}

const PAGE_SIZE = 30

/** Compact relative time — "just now", "5m ago", "3h ago", "2d ago", then a plain date. */
export function crmRelativeTime(value: string | Date): string {
  const d = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(d.getTime())) return ''
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return d.toLocaleDateString()
}

export function useCrmTimeline(typeKey: MaybeRefOrGetter<string>, recordId: MaybeRefOrGetter<string>) {
  const comments = ref<CrmCommentItem[]>([])
  const activity = ref<CrmActivityItem[]>([])
  const commentsCursor = ref<string | null>(null)
  const activityCursor = ref<string | null>(null)
  const pending = ref(false)
  const error = ref<string | null>(null)

  // Bumped on every reset so in-flight responses for a previous record drop.
  let epoch = 0

  const baseUrl = () => `/api/crm/records/${toValue(typeKey)}/${toValue(recordId)}`

  function fetchComments(before?: string | null): Promise<TimelinePage<CrmCommentItem>> {
    return $fetch<TimelinePage<CrmCommentItem>>(`${baseUrl()}/comments`, {
      query: { limit: PAGE_SIZE, ...(before ? { before } : {}) }
    })
  }

  function fetchActivity(before?: string | null): Promise<TimelinePage<CrmActivityItem>> {
    return $fetch<TimelinePage<CrmActivityItem>>(`${baseUrl()}/activity`, {
      query: { limit: PAGE_SIZE, ...(before ? { before } : {}) }
    })
  }

  /** Resets both streams and fetches their first pages. */
  async function refresh(): Promise<void> {
    if (!toValue(typeKey) || !toValue(recordId)) return
    const requestEpoch = ++epoch
    comments.value = []
    activity.value = []
    commentsCursor.value = null
    activityCursor.value = null
    pending.value = true
    try {
      const [commentPage, activityPage] = await Promise.all([fetchComments(), fetchActivity()])
      if (requestEpoch !== epoch) return
      comments.value = commentPage.items
      commentsCursor.value = commentPage.nextCursor
      activity.value = activityPage.items
      activityCursor.value = activityPage.nextCursor
      error.value = null
    } catch (err) {
      if (requestEpoch === epoch) error.value = crmErrorMessage(err, 'Failed to load activity')
    } finally {
      if (requestEpoch === epoch) pending.value = false
    }
  }

  /** Fetches the next page of every stream that still has one. */
  async function loadOlder(): Promise<void> {
    if (pending.value) return
    const requestEpoch = epoch
    const tasks: Promise<void>[] = []
    if (commentsCursor.value) {
      tasks.push(fetchComments(commentsCursor.value).then((page) => {
        if (requestEpoch !== epoch) return
        comments.value = [...comments.value, ...page.items]
        commentsCursor.value = page.nextCursor
      }))
    }
    if (activityCursor.value) {
      tasks.push(fetchActivity(activityCursor.value).then((page) => {
        if (requestEpoch !== epoch) return
        activity.value = [...activity.value, ...page.items]
        activityCursor.value = page.nextCursor
      }))
    }
    if (tasks.length === 0) return
    pending.value = true
    try {
      await Promise.all(tasks)
      if (requestEpoch === epoch) error.value = null
    } catch (err) {
      if (requestEpoch === epoch) error.value = crmErrorMessage(err, 'Failed to load older activity')
    } finally {
      if (requestEpoch === epoch) pending.value = false
    }
  }

  const entries = computed<CrmTimelineEntry[]>(() => {
    const merged: CrmTimelineEntry[] = [
      ...comments.value.map(c => ({ kind: 'comment' as const, id: `comment:${c.id}`, createdAt: c.createdAt, comment: c })),
      ...activity.value.map(a => ({ kind: 'activity' as const, id: `activity:${a.id}`, createdAt: a.createdAt, activity: a }))
    ]
    // ISO timestamps compare correctly as strings; ties break on id so the
    // order is stable across reloads.
    merged.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    // Frontier cut: each stream is only complete down to its oldest loaded
    // row. Streams arrive newest-first, so that row is the last element.
    const frontiers: string[] = []
    const oldestComment = comments.value[comments.value.length - 1]
    if (commentsCursor.value && oldestComment) frontiers.push(oldestComment.createdAt)
    const oldestActivity = activity.value[activity.value.length - 1]
    if (activityCursor.value && oldestActivity) frontiers.push(oldestActivity.createdAt)
    if (frontiers.length === 0) return merged
    const cut = frontiers.reduce((a, b) => (a > b ? a : b))
    return merged.filter(e => e.createdAt >= cut)
  })

  const hasMore = computed(() => commentsCursor.value !== null || activityCursor.value !== null)

  /** Posts a comment and prepends it to the stream. Throws on failure. */
  async function post(body: string): Promise<CrmCommentItem> {
    const created = await $fetch<CrmCommentItem>(`${baseUrl()}/comments`, {
      method: 'POST',
      body: { body }
    })
    comments.value = [created, ...comments.value]
    return created
  }

  /** Edits a comment in place. Throws on failure (list stays unchanged). */
  async function editComment(id: string, body: string): Promise<CrmCommentItem> {
    const updated = await $fetch<CrmCommentItem>(`/api/crm/comments/${id}`, {
      method: 'PATCH',
      body: { body }
    })
    comments.value = comments.value.map(c => (c.id === id ? updated : c))
    return updated
  }

  /** Deletes a comment and removes it from the stream. Throws on failure. */
  async function removeComment(id: string): Promise<void> {
    await $fetch(`/api/crm/comments/${id}`, { method: 'DELETE' })
    comments.value = comments.value.filter(c => c.id !== id)
  }

  watch(
    () => [toValue(typeKey), toValue(recordId)],
    () => {
      refresh()
    },
    { immediate: true }
  )

  return { entries, hasMore, pending, error, loadOlder, post, editComment, removeComment, refresh }
}
