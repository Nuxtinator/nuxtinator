// The caller's favorite cards and card boards (server/utils/favorites.ts),
// shared by the landing page, a card board's header, and a card's menu and
// details. Cached per org, since switching orgs is an SPA navigation.
import type { ViewsFavorite, ViewsFavoriteKind } from '../utils/views-types'

const inflight = new Map<string, Promise<void>>()
const saving = new Set<string>()

export function useViewsFavorites() {
  const cache = useState<Record<string, ViewsFavorite[]>>('views:favorites', () => ({}))
  const orgKey = useRecordsOrgKey()
  const toast = useToast()

  const items = computed(() => cache.value[orgKey.value] ?? [])

  function store(key: string, list: ViewsFavorite[]) {
    cache.value = { ...cache.value, [key]: list }
  }

  /** Refetches the active org's favorites. */
  async function refresh(): Promise<void> {
    const key = orgKey.value
    const res = await $fetch<{ items: ViewsFavorite[] }>('/api/views/favorites')
    store(key, res.items)
  }

  /** Fetches them once per org; until they arrive nothing shows as a favorite. */
  function ensure(): void {
    const key = orgKey.value
    if (key in cache.value || inflight.has(key)) return
    inflight.set(key, refresh()
      .catch(() => {
        // Stars show as off; the next landing-page visit refetches.
      })
      .finally(() => {
        inflight.delete(key)
      }))
  }

  const same = (kind: ViewsFavoriteKind, recordId: string) => (f: ViewsFavorite) =>
    f.kind === kind && f.recordId === recordId

  function isFavorite(kind: ViewsFavoriteKind, recordId: string): boolean {
    return items.value.some(same(kind, recordId))
  }

  /**
   * Adds the favorite, or removes it when it is one. A card opens on
   * `viewId`. The star changes at once and goes back if the save fails.
   */
  async function toggle(kind: ViewsFavoriteKind, recordId: string, viewId?: string): Promise<void> {
    const key = orgKey.value
    const busyKey = `${key}:${kind}:${recordId}`
    if (saving.has(busyKey)) return
    saving.add(busyKey)
    const before = cache.value[key] ?? []
    const removing = before.some(same(kind, recordId))
    try {
      if (removing) {
        store(key, before.filter(f => !same(kind, recordId)(f)))
        await $fetch(`/api/views/favorites/${kind}/${recordId}`, { method: 'DELETE' })
      } else {
        store(key, [...before, { kind, recordId, name: '', recordType: '', viewId: viewId ?? null, viewName: null }])
        const added = await $fetch<ViewsFavorite>(`/api/views/favorites/${kind}/${recordId}`, {
          method: 'PUT',
          body: viewId ? { viewId } : {}
        })
        store(key, (cache.value[key] ?? []).map(f => same(kind, recordId)(f) ? added : f))
      }
    } catch (err) {
      const now = (cache.value[key] ?? []).filter(f => !same(kind, recordId)(f))
      if (removing) {
        const at = before.findIndex(same(kind, recordId))
        now.splice(Math.min(at, now.length), 0, before[at]!)
      }
      store(key, now)
      toast.add({
        color: 'error',
        title: recordsErrorMessage(err, removing ? 'Failed to remove the favorite' : 'Failed to add the favorite')
      })
    } finally {
      saving.delete(busyKey)
    }
  }

  return { items, refresh, ensure, isFavorite, toggle }
}
