// One open view: its detail row with its tabs, the active tab's record feed,
// and the poll loop that keeps the feed fresh. Polling refetches every 15s while the tab is
// visible, pauses while it's hidden, refetches immediately on focus, and
// suspends while a drag is unsettled so a poll result can't flash-revert a
// card mid-drop (the drag interaction brackets itself with beginDrag /
// endDrag).

import type {
  ViewDetail,
  ViewRecords,
  ViewsTab
} from '../utils/views-types'

const POLL_INTERVAL_MS = 15_000

export interface ViewsMovePayload {
  recordId: string
  fromColumn: string | null
  toColumn: string
  columnOrder: string[]
  /** Resends a drag refused for handing the card to someone who can't see it yet. */
  confirmShare?: boolean
}

export function useViewsDetail(viewId: MaybeRefOrGetter<string>, tabId: MaybeRefOrGetter<string | null>) {
  const view = ref<ViewDetail | null>(null)
  const records = ref<ViewRecords | null>(null)
  const pending = ref(false)
  const error = ref<string | null>(null)

  /** The tab on screen: the requested one, else the view's first. */
  const tab = computed<ViewsTab | null>(() => {
    const tabs = view.value?.tabs ?? []
    return tabs.find(t => t.id === toValue(tabId)) ?? tabs[0] ?? null
  })

  // Session-only text search and table sort; nothing here is persisted.
  const q = ref('')
  const sort = ref<string | null>(null)
  const dir = ref<'asc' | 'desc' | null>(null)
  // Table mode pages; boards always load the whole (capped) set.
  const page = ref(1)
  const pageSize = 25

  let requestId = 0
  let dragDepth = 0

  async function refreshView(): Promise<void> {
    const id = toValue(viewId)
    if (!id) return
    view.value = await $fetch<ViewDetail>(`/api/views/${id}`)
  }

  async function refreshRecords(): Promise<void> {
    const id = toValue(viewId)
    if (!id || dragDepth > 0) return
    const reqId = ++requestId
    pending.value = true
    try {
      const isTable = tab.value?.layout === 'table'
      const res = await $fetch<ViewRecords>(`/api/views/${id}/records`, {
        query: {
          tab: tab.value?.id,
          q: q.value || undefined,
          sort: isTable ? sort.value || undefined : undefined,
          dir: isTable ? dir.value || undefined : undefined,
          limit: isTable ? pageSize : undefined,
          offset: isTable ? (page.value - 1) * pageSize : undefined
        }
      })
      if (reqId !== requestId) return
      records.value = res
      error.value = null
    } catch (err) {
      if (reqId !== requestId) return
      error.value = recordsErrorMessage(err, 'Failed to load records')
    } finally {
      if (reqId === requestId) pending.value = false
    }
  }

  async function refresh(): Promise<void> {
    try {
      await refreshView()
      await refreshRecords()
    } catch (err) {
      error.value = recordsErrorMessage(err, 'Failed to load view')
    }
  }

  // --- poll loop -----------------------------------------------------------

  let timer: ReturnType<typeof setInterval> | null = null

  function startPolling() {
    stopPolling()
    timer = setInterval(() => {
      if (document.visibilityState === 'visible') refreshRecords()
    }, POLL_INTERVAL_MS)
  }
  function stopPolling() {
    if (timer) clearInterval(timer)
    timer = null
  }
  function onVisibility() {
    if (document.visibilityState === 'visible') refreshRecords()
  }

  onMounted(() => {
    startPolling()
    document.addEventListener('visibilitychange', onVisibility)
  })
  onBeforeUnmount(() => {
    stopPolling()
    document.removeEventListener('visibilitychange', onVisibility)
  })

  // --- drag bracket --------------------------------------------------------

  function beginDrag() {
    dragDepth += 1
  }
  function endDrag() {
    dragDepth = Math.max(0, dragDepth - 1)
  }

  async function move(payload: ViewsMovePayload): Promise<void> {
    const id = toValue(viewId)
    await $fetch(`/api/views/${id}/move`, { method: 'POST', body: { ...payload, tabId: tab.value?.id } })
  }

  watch(() => toValue(viewId), () => {
    view.value = null
    records.value = null
    refresh()
  }, { immediate: true })

  watch([q, sort, dir, page], () => {
    refreshRecords()
  })

  // A different tab starts from its own saved sort, page one and no stale feed.
  watch(() => tab.value?.id, (next, prev) => {
    if (!next || next === prev || prev === undefined) return
    records.value = null
    sort.value = null
    dir.value = null
    page.value = 1
    refreshRecords()
  })

  return {
    view,
    tab,
    records,
    pending,
    error,
    q,
    sort,
    dir,
    page,
    pageSize,
    refresh,
    refreshRecords,
    beginDrag,
    endDrag,
    move
  }
}
