// List + rail state for the inbox, bound to the URL query (scope, status, q)
// so views are shareable and survive reloads. Org-keyed watchers: org
// switches are SPA navigation and reuse this page component, so every fetch
// watch includes the org key, never just the route params.

export interface InboxConversationListRow {
  id: string
  subject: string | null
  status: string
  assignedUserId: string | null
  assigneeName: string | null
  needsReview: boolean
  source: string
  counterpartyName: string | null
  tags: string[]
  channelValue: string
  messageCount: number
  snippet: string | null
  lastMessageAt: string | null
  lastMessageDirection: string | null
  createdAt: string
}

export interface InboxCounts {
  all: number
  unassigned: number
  mine: number
  held: number
  open: number
  pending: number
}

export type InboxScope = 'all' | 'unassigned' | 'mine' | 'held'

export function useInboxConversations() {
  const route = useRoute()
  const router = useRouter()
  const orgKey = useCrmOrgKey()

  const items = ref<InboxConversationListRow[]>([])
  const total = ref(0)
  const counts = ref<InboxCounts | null>(null)
  const tagCounts = ref<Record<string, number>>({})
  const pending = ref(false)
  const error = ref<string | null>(null)

  function queryString(key: string): string {
    const raw = route.query[key]
    if (typeof raw === 'string') return raw
    if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0]
    return ''
  }

  function setQuery(patch: Record<string, string | undefined>) {
    const merged: Record<string, unknown> = { ...route.query, ...patch }
    const next = Object.fromEntries(
      Object.entries(merged).filter(([, value]) => value !== undefined && value !== '')
    )
    router.replace({ query: next as Record<string, string> })
  }

  const scope = computed<InboxScope>({
    get: () => {
      const raw = queryString('scope')
      return raw === 'unassigned' || raw === 'mine' || raw === 'held' ? raw : 'all'
    },
    // Scope and tag are competing folder dimensions — picking a scope clears
    // any active tag so the rail never shows two folders selected at once.
    set: v => setQuery({ scope: v === 'all' ? undefined : v, tag: undefined })
  })

  // Status default is per-scope: normal views open on 'open'; the held review
  // queue opens unnarrowed ('all' — it's the whole alarm queue) and a status
  // choice within it is an explicit opt-in.
  const status = computed<string>({
    get: () => queryString('status') || (scope.value === 'held' ? 'all' : 'open'),
    set: (v) => {
      const scopeDefault = scope.value === 'held' ? 'all' : 'open'
      setQuery({ status: v === scopeDefault ? undefined : v })
    }
  })

  // The active tag folder (empty = none). Selecting a tag clears the scope and
  // resets the status to 'all': tag folders are cross-status, so the visible
  // list must span every status (bar spam) to match the tag's rail count.
  const tag = computed<string>({
    get: () => queryString('tag'),
    set: v => setQuery({ tag: v || undefined, scope: undefined, status: v ? 'all' : undefined })
  })

  const q = computed<string>({
    get: () => queryString('q'),
    set: v => setQuery({ q: v || undefined })
  })

  let requestId = 0
  async function refresh(): Promise<void> {
    const id = ++requestId
    pending.value = true
    const statusParam = status.value === 'all' ? undefined : status.value
    const query: Record<string, unknown> = { limit: 100 }
    if (tag.value) {
      // Tag folder overrides scope. Status may still narrow within it, but
      // defaults to 'all' (set when the tag was selected).
      query.tag = tag.value
      if (statusParam) query.status = statusParam
    } else if (scope.value === 'held') {
      // The whole review queue by default; the status strip can narrow it.
      query.held = true
      if (statusParam) query.status = statusParam
    } else {
      if (statusParam) query.status = statusParam
      if (scope.value === 'unassigned') query.unassigned = true
      if (scope.value === 'mine') query.mine = true
    }
    if (q.value) query.q = q.value
    try {
      const [list, badge, tagRes] = await Promise.all([
        $fetch<{ items: InboxConversationListRow[], total: number }>('/api/inbox/conversations', { query }),
        $fetch<InboxCounts>('/api/inbox/conversations/counts', {
          query: { status: statusParam, scope: scope.value }
        }),
        $fetch<{ counts: Record<string, number> }>('/api/inbox/conversations/tag-counts')
      ])
      if (id !== requestId) return
      items.value = list.items
      total.value = list.total
      counts.value = badge
      tagCounts.value = tagRes.counts
      error.value = null
    } catch (err) {
      if (id !== requestId) return
      error.value = err instanceof Error ? err.message : 'Failed to load conversations'
    } finally {
      if (id === requestId) pending.value = false
    }
  }

  let debounce: ReturnType<typeof setTimeout> | null = null
  watch([scope, status, tag, orgKey], () => refresh(), { immediate: true })
  watch(q, () => {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => refresh(), 300)
  })

  // Bulk triage over checked rows (status / assignee / add tags); resolves to
  // how many conversations actually changed.
  async function applyBulk(
    ids: string[],
    action: { status?: string, assignedUserId?: string | null, addTags?: string[] }
  ): Promise<number> {
    const res = await $fetch<{ updated: number }>('/api/inbox/conversations/bulk', {
      method: 'POST',
      body: { ids, ...action }
    })
    return res.updated
  }

  return { items, total, counts, tagCounts, pending, error, scope, status, q, tag, refresh, applyBulk }
}
