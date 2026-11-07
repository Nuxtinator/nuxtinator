// Knowledge-base CRUD for the inbox (client). Org-keyed refresh; also carries
// the manual grounding-refresh action. Mirrors the shape of useInboxCanned.
export interface InboxKnowledgeEntry {
  id: string
  question: string
  answer: string
  language: string
  status: string
  sourceConversationId: string | null
  createdAt: string
  updatedAt: string
}

export type InboxKnowledgeStatusFilter = 'active' | 'archived' | 'all'

export interface InboxGroundingRefreshResult {
  synced: string[]
  failed: { url: string, error: string }[]
  pruned: number
}

export function useInboxKnowledge() {
  const orgKey = useRecordsOrgKey()
  const items = ref<InboxKnowledgeEntry[]>([])
  const statusFilter = ref<InboxKnowledgeStatusFilter>('all')
  const loaded = ref(false)
  const failed = ref(false)

  async function refresh() {
    try {
      const q = statusFilter.value !== 'all' ? `?status=${statusFilter.value}` : ''
      const url: string = `/api/inbox/knowledge-entries${q}`
      const res = await $fetch<{ entries: InboxKnowledgeEntry[] }>(url)
      items.value = res.entries
      failed.value = false
    } catch {
      items.value = []
      failed.value = true
    } finally {
      loaded.value = true
    }
  }

  async function create(body: { question: string, answer: string, language?: string, sourceConversationId?: string }) {
    await $fetch<{ entry: InboxKnowledgeEntry }>('/api/inbox/knowledge-entries', { method: 'POST', body })
    await refresh()
  }

  async function update(id: string, body: { question?: string, answer?: string, language?: string, status?: 'active' | 'archived' }) {
    const url: string = `/api/inbox/knowledge-entries/${id}`
    await $fetch<{ entry: InboxKnowledgeEntry }>(url, { method: 'PUT', body })
    await refresh()
  }

  async function remove(id: string) {
    const url: string = `/api/inbox/knowledge-entries/${id}`
    await $fetch<{ ok: boolean }>(url, { method: 'DELETE' })
    await refresh()
  }

  async function refreshGrounding(): Promise<InboxGroundingRefreshResult> {
    return await $fetch<InboxGroundingRefreshResult>('/api/inbox/grounding/refresh', { method: 'POST' })
  }

  watch([orgKey, statusFilter], () => refresh(), { immediate: true })

  return { items, statusFilter, loaded, failed, refresh, create, update, remove, refreshGrounding }
}
