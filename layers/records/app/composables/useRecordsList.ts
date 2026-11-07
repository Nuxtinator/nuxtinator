// List state for one record type, bound to the URL query (q, status,
// filters, sort, dir, page) so views are shareable and survive reloads.
// `filters` is a JSON-encoded object of field-keyed list-engine conditions;
// `status` stays its own param and merges into it at request time. Every
// query change triggers a refetch; stale responses are dropped.

import type { MaybeRefOrGetter } from 'vue'

/** A list row as served by GET /api/records/entries/:type. */
export interface RecordListItem {
  id: string
  name: string
  status: string | null
  updatedAt: string
  createdAt: string
  assignedTo: string[]
  /** Raw jsonb map — holds values for jsonb-stored fields only. */
  data: Record<string, unknown>
}

export const RECORDS_LIST_PAGE_SIZE = 25

export function useRecordsList(typeKey: MaybeRefOrGetter<string>) {
  const route = useRoute()
  const router = useRouter()

  const items = ref<RecordListItem[]>([])
  const total = ref(0)
  const pending = ref(false)
  const error = ref<string | null>(null)

  function queryString(key: string): string {
    const raw = route.query[key]
    if (typeof raw === 'string') return raw
    if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0]
    return ''
  }

  /** Merges a patch into the current query; empty values remove the key. */
  function setQuery(patch: Record<string, string | undefined>) {
    const merged: Record<string, unknown> = { ...route.query, ...patch }
    const next = Object.fromEntries(
      Object.entries(merged).filter(([, value]) => value !== undefined && value !== '')
    )
    router.replace({ query: next as Record<string, string> })
  }

  const q = computed<string>({
    get: () => queryString('q'),
    set: v => setQuery({ q: v || undefined, page: undefined })
  })

  const status = computed<string | null>({
    get: () => queryString('status') || null,
    set: v => setQuery({ status: v || undefined, page: undefined })
  })

  const filters = computed<Record<string, unknown>>({
    get: () => {
      const raw = queryString('filters')
      if (!raw) return {}
      try {
        const parsed: unknown = JSON.parse(raw)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>
        }
      } catch {
        // Malformed hand-edited URLs read as "no filters".
      }
      return {}
    },
    set: v => setQuery({
      filters: Object.keys(v).length > 0 ? JSON.stringify(v) : undefined,
      page: undefined
    })
  })

  const sort = computed<string>(() => queryString('sort') || 'updated_at')
  const dir = computed<'asc' | 'desc'>(() => {
    const raw = queryString('dir')
    if (raw === 'asc' || raw === 'desc') return raw
    return 'desc'
  })

  function toggleSort(field: string) {
    if (sort.value === field) {
      setQuery({ sort: field, dir: dir.value === 'asc' ? 'desc' : 'asc', page: undefined })
    } else {
      // Timestamps read most-recent-first; everything else starts ascending.
      const firstDir = field === 'updated_at' || field === 'created_at' ? 'desc' : 'asc'
      setQuery({ sort: field, dir: firstDir, page: undefined })
    }
  }

  const page = computed<number>({
    get: () => {
      const n = Number.parseInt(queryString('page'), 10)
      return Number.isFinite(n) && n > 0 ? n : 1
    },
    set: v => setQuery({ page: v > 1 ? String(v) : undefined })
  })

  let requestId = 0
  async function refresh(): Promise<void> {
    const key = toValue(typeKey)
    if (!key) return
    const id = ++requestId
    pending.value = true
    const combined: Record<string, unknown> = { ...filters.value }
    if (status.value) combined.status = status.value
    try {
      const res = await $fetch<{ items: RecordListItem[], total: number }>(
        `/api/records/entries/${key}`,
        {
          query: {
            q: q.value || undefined,
            sort: sort.value,
            dir: dir.value,
            limit: RECORDS_LIST_PAGE_SIZE,
            offset: (page.value - 1) * RECORDS_LIST_PAGE_SIZE,
            filters: Object.keys(combined).length > 0 ? JSON.stringify(combined) : undefined
          }
        }
      )
      if (id !== requestId) return
      items.value = res.items
      total.value = res.total
      error.value = null
    } catch (err) {
      if (id !== requestId) return
      error.value = recordsErrorMessage(err, 'Failed to load records')
    } finally {
      if (id === requestId) pending.value = false
    }
  }

  watch(
    () => [toValue(typeKey), q.value, status.value, queryString('filters'), sort.value, dir.value, page.value],
    () => {
      refresh()
    },
    { immediate: true }
  )

  return {
    items,
    total,
    pending,
    error,
    page,
    pageSize: RECORDS_LIST_PAGE_SIZE,
    q,
    status,
    filters,
    sort,
    dir,
    toggleSort,
    refresh
  }
}
