// Active deliverability suppressions for the org, for the admin manager. Loaded
// on demand (when the manager opens), not org-keyed at mount — it's a rarely-
// opened surface.

export interface InboxSuppression {
  channelId: string
  value: string
  reason: string
  detail: string | null
  source: string | null
  since: string
  recordNames: string[]
  // False for the mail kernel's bounces and complaints, which a host admin
  // clears under Admin → Email.
  clearable: boolean
}

export function useInboxSuppressions() {
  const items = ref<InboxSuppression[]>([])
  const pending = ref(false)
  const error = ref<string | null>(null)

  async function refresh(): Promise<void> {
    pending.value = true
    try {
      items.value = (await $fetch<{ items: InboxSuppression[] }>('/api/inbox/suppressions')).items
      error.value = null
    } catch (err) {
      items.value = []
      error.value = err instanceof Error ? err.message : 'Failed to load suppressions'
    } finally {
      pending.value = false
    }
  }

  async function clear(channelId: string): Promise<void> {
    const url: string = `/api/inbox/suppressions/${channelId}/clear`
    await $fetch(url, { method: 'POST' })
    await refresh()
  }

  return { items, pending, error, refresh, clear }
}
