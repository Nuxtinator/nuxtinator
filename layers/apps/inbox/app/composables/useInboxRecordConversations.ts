// Data for the inbox panel on a CRM record page: every conversation across the
// record's linked email addresses, plus those channels (so the panel can start
// a new conversation to a locked recipient). Org-keyed. A 403 flips `denied` so
// the panel hides itself rather than showing an error card.
import type { MaybeRefOrGetter } from 'vue'

export interface InboxRecordConversationRow {
  id: string
  subject: string | null
  status: string
  needsReview: boolean
  source: string
  counterpartyName: string | null
  assigneeName: string | null
  tags: string[]
  channelValue: string
  messageCount: number
  snippet: string | null
  lastMessageAt: string | null
  lastMessageDirection: string | null
  createdAt: string
}

export interface InboxRecordChannel {
  channelId: string
  value: string
  isPrimary: boolean
}

export function useInboxRecordConversations(recordId: MaybeRefOrGetter<string>) {
  const orgKey = useRecordsOrgKey()
  const items = ref<InboxRecordConversationRow[]>([])
  const channels = ref<InboxRecordChannel[]>([])
  // Total matching conversations — can exceed items.length (the list itself
  // is capped server-side), which the panel surfaces as "showing latest N".
  const total = ref(0)
  const pending = ref(false)
  const denied = ref(false)

  async function refresh(): Promise<void> {
    const id = toValue(recordId)
    if (!id) return
    pending.value = true
    try {
      // The second generic pins the request type to `string` so $fetch resolves
      // its return against the fallback branch instead of deep-instantiating over
      // the full typed-route union (which trips TS2589 as the app grows).
      const res = await $fetch<{ items: InboxRecordConversationRow[], channels: InboxRecordChannel[], total: number }, string>(
        `/api/inbox/records/${id}/conversations`
      )
      items.value = res.items
      channels.value = res.channels
      total.value = res.total
      denied.value = false
    } catch (err) {
      items.value = []
      channels.value = []
      total.value = 0
      denied.value = (err as { statusCode?: number })?.statusCode === 403
    } finally {
      pending.value = false
    }
  }

  watch([() => toValue(recordId), orgKey], () => refresh(), { immediate: true })

  return { items, channels, total, pending, denied, refresh }
}
