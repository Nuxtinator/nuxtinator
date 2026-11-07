// The "Notes & Activity" feed for one conversation: internal notes (keyset-
// paginated, newest-first) merged with the audit trail (a flat latest-100) into
// one timeline. Notes and activity carry differently-typed timestamps (comment
// ISO string vs the activity_logs value), so both are normalized to epoch-ms
// before sorting or the merge would NaN-sort. Promise.allSettled so one failed
// stream doesn't blank the other. Org- and conversation-keyed with an epoch
// guard so a stale response for a previous conversation is dropped.
import type { MaybeRefOrGetter } from 'vue'

export interface InboxNote {
  id: string
  authorId: string | null
  authorName: string
  body: string
  createdAt: string
  editedAt: string | null
}

export interface InboxActivityItem {
  id: string
  eventType: string
  message: string | null
  actorId: string | null
  actorName: string | null
  at: string | number
}

export type InboxTimelineEntry =
  | { kind: 'note', id: string, ts: number, note: InboxNote }
  | { kind: 'activity', id: string, ts: number, activity: InboxActivityItem }

function toMs(v: string | number): number {
  return typeof v === 'number' ? v : Date.parse(v)
}

export function useInboxNotesTimeline(conversationId: MaybeRefOrGetter<string | null>) {
  const orgKey = useRecordsOrgKey()
  const notes = ref<InboxNote[]>([])
  const activity = ref<InboxActivityItem[]>([])
  const notesCursor = ref<string | null>(null)
  const pending = ref(false)
  const error = ref<string | null>(null)
  let epoch = 0

  const entries = computed<InboxTimelineEntry[]>(() => {
    const merged: InboxTimelineEntry[] = [
      ...notes.value.map(n => ({ kind: 'note' as const, id: `note:${n.id}`, ts: toMs(n.createdAt), note: n })),
      ...activity.value.map(a => ({ kind: 'activity' as const, id: `activity:${a.id}`, ts: toMs(a.at), activity: a }))
    ]
    merged.sort((a, b) => b.ts - a.ts || b.id.localeCompare(a.id))
    return merged
  })
  const hasMore = computed(() => !!notesCursor.value)

  async function refresh(): Promise<void> {
    const id = toValue(conversationId)
    if (!id) { notes.value = []; activity.value = []; notesCursor.value = null; return }
    const myEpoch = ++epoch
    pending.value = true
    const [notesRes, actRes] = await Promise.allSettled([
      $fetch<{ items: InboxNote[], nextCursor: string | null }>(`/api/inbox/conversations/${id}/comments`),
      $fetch<{ items: InboxActivityItem[] }>(`/api/inbox/conversations/${id}/activity`)
    ])
    if (myEpoch !== epoch) return
    if (notesRes.status === 'fulfilled') { notes.value = notesRes.value.items; notesCursor.value = notesRes.value.nextCursor }
    if (actRes.status === 'fulfilled') { activity.value = actRes.value.items }
    error.value = notesRes.status === 'rejected' && actRes.status === 'rejected' ? 'Failed to load notes & activity' : null
    pending.value = false
  }

  async function loadOlder(): Promise<void> {
    const id = toValue(conversationId)
    if (!id || !notesCursor.value) return
    const res = await $fetch<{ items: InboxNote[], nextCursor: string | null }>(
      `/api/inbox/conversations/${id}/comments`, { query: { before: notesCursor.value } }
    )
    notes.value = [...notes.value, ...res.items]
    notesCursor.value = res.nextCursor
  }

  // Mentions ride the body's mention spans; the server extracts recipients
  // from the sanitized markup.
  async function post(body: string): Promise<void> {
    const id = toValue(conversationId)
    if (!id) return
    const note = await $fetch<InboxNote>(`/api/inbox/conversations/${id}/comments`, {
      method: 'POST', body: { body }
    })
    notes.value = [note, ...notes.value]
  }

  async function editNote(commentId: string, body: string): Promise<void> {
    const id = toValue(conversationId)
    if (!id) return
    const url: string = `/api/inbox/conversations/${id}/comments/${commentId}`
    const updated = await $fetch<InboxNote>(url, { method: 'PATCH', body: { body } })
    notes.value = notes.value.map(n => n.id === commentId ? updated : n)
  }

  async function removeNote(commentId: string): Promise<void> {
    const id = toValue(conversationId)
    if (!id) return
    const url: string = `/api/inbox/conversations/${id}/comments/${commentId}`
    await $fetch(url, { method: 'DELETE' })
    notes.value = notes.value.filter(n => n.id !== commentId)
  }

  watch([() => toValue(conversationId), orgKey], () => refresh(), { immediate: true })

  return { entries, hasMore, pending, error, refresh, loadOlder, post, editNote, removeNote }
}
