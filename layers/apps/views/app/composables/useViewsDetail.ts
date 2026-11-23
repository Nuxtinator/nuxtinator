// One open view: its detail row with its tabs, the active tab's record feed,
// and the poll loop that keeps the feed fresh. Polling refetches every 15s while the tab is
// visible, pauses while it's hidden, refetches immediately on focus, and
// waits while a drag or a write is unsettled (a hold), dropping any fetch
// already on its way, so no result can paint the old state over what's on
// screen. Writes go through `optimistic`: the screen changes first and goes
// back only if the write fails.

import type {
  ViewDetail,
  ViewRecords,
  ViewsTab
} from '../utils/views-types'

const POLL_INTERVAL_MS = 15_000
const LIST_PAGE = 100
// The server's per-request ceiling for a list.
const LIST_REQUEST_MAX = VIEWS_BOARD_CAP

export interface ViewsMovePayload {
  recordId: string
  fromColumn: string | null
  toColumn: string
  columnOrder: string[]
  /** Resends a drag refused for handing the card to someone who can't see it yet. */
  confirmShare?: boolean
}

export function useViewsDetail(
  viewId: MaybeRefOrGetter<string>,
  tabId: MaybeRefOrGetter<string | null>,
  /** The days a calendar tab shows; its feed holds the records on them. */
  calendarRange: MaybeRefOrGetter<{ from: string, to: string } | null> = null
) {
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
  // A list loads a page at a time as it scrolls, and each refresh refetches
  // every row loaded so far, in requests of at most LIST_REQUEST_MAX.
  const listRows = ref(LIST_PAGE)

  let requestId = 0
  let viewRequestId = 0
  let viewLoads = 0
  let holds = 0
  // A fetch was skipped or dropped while held; the last release refetches.
  let feedOutdated = false
  let viewOutdated = false

  async function refreshView(): Promise<void> {
    const id = toValue(viewId)
    if (!id) return
    // A view opened while something is held still loads.
    if (holds > 0 && view.value) {
      viewOutdated = true
      return
    }
    const reqId = ++viewRequestId
    viewLoads += 1
    let res: ViewDetail
    try {
      res = await $fetch<ViewDetail>(`/api/views/${id}`)
    } finally {
      viewLoads -= 1
    }
    if (reqId !== viewRequestId) {
      viewOutdated = true
      return
    }
    view.value = res
    viewOutdated = false
  }

  async function fetchList(url: string, query: Record<string, unknown>): Promise<ViewRecords> {
    let first: ViewRecords | null = null
    const byId = new Map<string, ViewRecords['items'][number]>()
    for (let offset = 0; offset < listRows.value; offset += LIST_REQUEST_MAX) {
      const chunk = await $fetch<ViewRecords>(url, {
        query: { ...query, limit: Math.min(LIST_REQUEST_MAX, listRows.value - offset), offset }
      })
      first ??= chunk
      for (const item of chunk.items) byId.set(item.id, item)
      if (!chunk.truncated) break
    }
    const items = [...byId.values()]
    return { ...first!, items, truncated: items.length < first!.total }
  }

  async function refreshRecords(): Promise<void> {
    const id = toValue(viewId)
    if (!id) return
    if (holds > 0) {
      feedOutdated = true
      return
    }
    const reqId = ++requestId
    pending.value = true
    try {
      const isTable = tab.value?.layout === 'table'
      const range = tab.value?.layout === 'calendar' ? toValue(calendarRange) : null
      const url = `/api/views/${id}/records`
      const query = {
        tab: tab.value?.id,
        q: q.value || undefined,
        sort: isTable ? sort.value || undefined : undefined,
        dir: isTable ? dir.value || undefined : undefined,
        limit: isTable ? pageSize : undefined,
        offset: isTable ? (page.value - 1) * pageSize : undefined,
        from: range?.from,
        to: range?.to
      }
      const res = tab.value?.layout === 'list'
        ? await fetchList(url, query)
        : await $fetch<ViewRecords>(url, { query })
      if (reqId !== requestId) {
        feedOutdated = true
        return
      }
      records.value = res
      feedOutdated = false
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
      if (document.visibilityState === 'visible') catchUp()
    }, POLL_INTERVAL_MS)
  }
  function stopPolling() {
    if (timer) clearInterval(timer)
    timer = null
  }
  function onVisibility() {
    if (document.visibilityState === 'visible') catchUp()
  }

  onMounted(() => {
    startPolling()
    document.addEventListener('visibilitychange', onVisibility)
  })
  onBeforeUnmount(() => {
    stopPolling()
    document.removeEventListener('visibilitychange', onVisibility)
  })

  // --- holds ---------------------------------------------------------------

  // A drag brackets itself with beginDrag / endDrag; a write holds through
  // `optimistic`.
  function beginDrag() {
    holds += 1
    if (pending.value) feedOutdated = true
    if (viewLoads > 0) viewOutdated = true
    requestId += 1
    viewRequestId += 1
    pending.value = false
  }
  function endDrag() {
    holds = Math.max(0, holds - 1)
    if (holds === 0 && (feedOutdated || viewOutdated)) catchUp()
  }

  /** Refetches what a hold kept off the screen: the feed, and the view when a fetch of it was skipped. */
  function catchUp(): Promise<void> {
    return viewOutdated ? refresh() : refreshRecords()
  }

  const snapshot = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

  /**
   * Shows a write before the server has it: `change` edits the feed (or,
   * with `view`, the view) at once, and `write` runs under a hold. A write
   * that throws, or resolves false because the person declined it, puts
   * that back as it was. Either way it's refetched once nothing is held.
   */
  async function optimistic(
    change: () => void,
    write: () => Promise<boolean>,
    opts: { view?: boolean } = {}
  ): Promise<void> {
    const shownView = view.value
    const shownFeed = records.value
    const before = opts.view
      ? shownView ? snapshot(shownView) : null
      : shownFeed ? snapshot(shownFeed) : null
    beginDrag()
    let saved = false
    try {
      change()
      saved = await write()
    } finally {
      if (!saved && before) {
        if (opts.view && view.value === shownView) view.value = before as ViewDetail
        if (!opts.view && records.value === shownFeed) records.value = before as ViewRecords
      }
      if (opts.view) viewOutdated = true
      else feedOutdated = true
      endDrag()
    }
  }

  async function move(payload: ViewsMovePayload): Promise<{ ok: boolean }> {
    const id = toValue(viewId)
    return await $fetch<{ ok: boolean }>(`/api/views/${id}/move`, { method: 'POST', body: { ...payload, tabId: tab.value?.id } })
  }

  /** A list's next page, once the rows loaded so far have arrived. */
  async function loadMore(): Promise<void> {
    if (holds > 0 || pending.value || tab.value?.layout !== 'list' || !records.value?.truncated) return
    listRows.value += LIST_PAGE
    await refreshRecords()
  }

  watch(() => toValue(viewId), () => {
    view.value = null
    records.value = null
    listRows.value = LIST_PAGE
    refresh()
  }, { immediate: true })

  watch(q, () => {
    listRows.value = LIST_PAGE
  })

  watch([q, sort, dir, page], () => {
    refreshRecords()
  })

  watch(() => {
    const range = toValue(calendarRange)
    return range ? `${range.from}:${range.to}` : null
  }, (next, prev) => {
    if (next !== prev && tab.value?.layout === 'calendar') refreshRecords()
  })

  // A different tab starts from its own saved sort, page one and no stale feed.
  watch(() => tab.value?.id, (next, prev) => {
    if (!next || next === prev || prev === undefined) return
    records.value = null
    sort.value = null
    dir.value = null
    page.value = 1
    listRows.value = LIST_PAGE
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
    loadMore,
    beginDrag,
    endDrag,
    optimistic,
    move
  }
}
