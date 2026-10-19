export interface LayerUpdate {
  id: string
  name: string
  pkg: string
  policy: string
  current: string | null
  latestInRange: string | null
  latest: string | null
  updateAvailable: boolean
  majorHeld: boolean
  compatible: boolean
  unmet: { pkg: string, range: string, loaded: string | null }[]
}

interface LayerUpdatesResponse {
  updates: LayerUpdate[]
}

export async function useLayerUpdates() {
  const { data, refresh, pending, error } = await useFetch<LayerUpdatesResponse>('/api/_layer-updates', {
    default: () => ({ updates: [] })
  })

  const updates = computed<LayerUpdate[]>(() => data.value?.updates ?? [])
  // How many layers have something to act on — drives an "updates available" badge.
  const availableCount = computed(() => updates.value.filter(u => u.updateAvailable || u.majorHeld).length)

  // Bypass the 6h server-side cache and re-check the sources right now.
  const checking = ref(false)
  async function checkNow() {
    checking.value = true
    try {
      data.value = await $fetch<LayerUpdatesResponse>('/api/_layer-updates', { query: { refresh: '1' } })
    } finally {
      checking.value = false
    }
  }

  return { updates, availableCount, refresh, checkNow, checking, pending, error }
}
