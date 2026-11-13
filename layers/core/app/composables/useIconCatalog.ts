export interface IconCollection {
  prefix: string
  names: string[]
}

interface IconCatalogResponse {
  collections: IconCollection[]
}

// App-wide cache of the icon-name catalog served by /api/_icons. Loaded
// lazily — the IconPickerPanel calls load() when it first mounts — and
// shared by every picker instance afterwards.
export function useIconCatalog() {
  const collections = useState<IconCollection[] | null>('core:icon-catalog', () => null)
  const loading = useState<boolean>('core:icon-catalog-loading', () => false)

  async function load() {
    if (collections.value || loading.value) return
    loading.value = true
    try {
      const res = await $fetch<IconCatalogResponse>('/api/_icons')
      collections.value = res.collections
    } finally {
      loading.value = false
    }
  }

  return { collections, loading, load }
}
