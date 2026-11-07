// Shared org-wide canned responses: the reply-toolbar picker reads them; the
// manager modal creates/edits/deletes them. Fetched once per org (org-keyed
// watch) and cached here; the page owns a single instance and passes `items`
// down to both the picker and the manager so they never diverge.

export interface InboxCannedResponse {
  id: string
  title: string
  bodyHtml: string
  createdBy?: string | null
  createdAt?: string
  updatedAt?: string
}

export function useInboxCanned() {
  const orgKey = useRecordsOrgKey()
  const items = ref<InboxCannedResponse[]>([])
  const loaded = ref(false)
  // The picker degrades silently on a fetch failure (no error toast) — the
  // reply flow must never be blocked by an unavailable snippet list.
  const failed = ref(false)

  async function refresh(): Promise<void> {
    try {
      const res = await $fetch<{ items: InboxCannedResponse[] }>('/api/inbox/canned-responses')
      items.value = res.items
      failed.value = false
    } catch {
      items.value = []
      failed.value = true
    } finally {
      loaded.value = true
    }
  }

  async function create(title: string, bodyHtml: string): Promise<InboxCannedResponse> {
    const res = await $fetch<InboxCannedResponse>('/api/inbox/canned-responses', {
      method: 'POST',
      body: { title, bodyHtml }
    })
    await refresh()
    return res
  }

  async function update(id: string, patch: { title?: string, bodyHtml?: string }): Promise<InboxCannedResponse> {
    const url: string = `/api/inbox/canned-responses/${id}`
    const res = await $fetch<InboxCannedResponse>(url, { method: 'PUT', body: patch })
    await refresh()
    return res
  }

  async function remove(id: string): Promise<void> {
    const url: string = `/api/inbox/canned-responses/${id}`
    await $fetch(url, { method: 'DELETE' })
    await refresh()
  }

  watch(orgKey, () => refresh(), { immediate: true })

  return { items, loaded, failed, refresh, create, update, remove }
}
