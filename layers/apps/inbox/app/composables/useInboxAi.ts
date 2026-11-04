// AI readiness for the inbox. Gates the AI draft button / add-to-KB action on
// whether AI is configured AND a model is enabled for the feature.
export interface InboxAiStatus {
  configured: boolean
  hasEnabledModel: boolean
  featureAvailable: boolean
}

export function useInboxAiStatus(feature = 'inbox.draft') {
  const orgKey = useCrmOrgKey()
  const status = ref<InboxAiStatus>({ configured: false, hasEnabledModel: false, featureAvailable: false })

  async function refresh() {
    try {
      const url: string = `/api/ai/status?feature=${encodeURIComponent(feature)}`
      status.value = await $fetch<InboxAiStatus>(url)
    } catch {
      status.value = { configured: false, hasEnabledModel: false, featureAvailable: false }
    }
  }

  watch(orgKey, () => refresh(), { immediate: true })

  // The single flag the UI gates on: AI is usable for this feature.
  const available = computed(() => status.value.featureAvailable)
  return { status, available, refresh }
}
