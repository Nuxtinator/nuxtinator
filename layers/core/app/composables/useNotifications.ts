// Reactive global notification feed shared by the top-bar bell and the AppRail
// badges. State lives in `useState` so every call site reads one source of
// truth, and a single module-level interval drives polling no matter how many
// components mount the composable.
//
// Polling is gated: in single-tenant mode it always runs; in multi-tenant mode
// it only runs when there's an active org (the feed endpoint 404s without one,
// e.g. on the org picker).

import type { RouteLocationNormalized } from 'vue-router'
import { useActiveOrg } from '#tenant'

export interface NotificationActor {
  id: string
  display_name: string
  avatar: string
}

export interface Notification {
  id: string
  app_id: string
  title: string
  body: string | null
  icon: string
  link: string
  created_at: string
  read_at: string | null
  actor: NotificationActor | null
}

interface FeedResponse {
  notifications: Notification[]
  next_cursor: string | null
}

interface CountsResponse {
  total: number
  byApp: Record<string, number>
}

// Module-level so polling is a singleton across all mounts.
let interval: ReturnType<typeof setInterval> | null = null
let subscribers = 0
let removeRouteHook: (() => void) | null = null

// The naive (un-prefixed) forms of a route that a notification link can take:
// the bare path, and the path with its query.
function visitedLinks(to: RouteLocationNormalized): string[] {
  const path = to.path.replace(/^\/@[^/]+/, '') || '/'
  const query = to.fullPath.slice(to.path.length).split('#')[0]
  return [...new Set([path, path + query])]
}

export function useNotifications() {
  const items = useState<Notification[]>('notifications:items', () => [])
  const unreadCount = useState<number>('notifications:unread', () => 0)
  const byApp = useState<Record<string, number>>('notifications:byApp', () => ({}))
  const nextCursor = useState<string | null>('notifications:cursor', () => null)
  const pending = useState<boolean>('notifications:pending', () => false)

  const tenancyOn = !!useRuntimeConfig().public.tenancy
  const { slug } = useActiveOrg()
  const enabled = computed(() => !tenancyOn || !!slug.value)

  async function refresh() {
    if (!enabled.value) {
      items.value = []
      unreadCount.value = 0
      byApp.value = {}
      nextCursor.value = null
      return
    }
    pending.value = true
    try {
      const [feed, counts] = await Promise.all([
        $fetch<FeedResponse>('/api/notifications'),
        $fetch<CountsResponse>('/api/notifications/unread-counts')
      ])
      items.value = feed.notifications
      nextCursor.value = feed.next_cursor
      unreadCount.value = counts.total
      byApp.value = counts.byApp
    } finally {
      pending.value = false
    }
  }

  async function loadMore() {
    if (!enabled.value || !nextCursor.value) return
    const feed = await $fetch<FeedResponse>('/api/notifications', {
      query: { cursor: nextCursor.value }
    })
    items.value = [...items.value, ...feed.notifications]
    nextCursor.value = feed.next_cursor
  }

  async function markRead(ids?: string[]) {
    if (ids && ids.length === 0) return
    await $fetch('/api/notifications/read', {
      method: 'POST',
      body: ids ? { ids } : { all: true }
    })
    await refresh()
  }

  // Opening a notification's target by any route, not only from the bell,
  // marks it read.
  async function markVisitedRead(to: RouteLocationNormalized) {
    if (unreadCount.value === 0 || (tenancyOn && !to.params.orgSlug)) return
    const res = await $fetch<{ updated: number }>('/api/notifications/read', {
      method: 'POST',
      body: { links: visitedLinks(to) }
    })
    if (res.updated > 0) await refresh()
  }

  // Re-fetch when the active org changes (multi-tenant org switch).
  watch(slug, () => refresh())

  const router = useRouter()

  function start() {
    const loaded = refresh()
    subscribers++
    if (!removeRouteHook) {
      removeRouteHook = router.afterEach((to, _from, failure) => {
        if (!failure) markVisitedRead(to).catch(() => {})
      })
      // The page that was open before the hook existed.
      loaded.then(() => markVisitedRead(router.currentRoute.value)).catch(() => {})
    }
    if (interval) return
    interval = setInterval(refresh, 30_000)
  }

  function stop() {
    subscribers = Math.max(0, subscribers - 1)
    if (subscribers === 0 && interval) {
      clearInterval(interval)
      interval = null
    }
    if (subscribers === 0 && removeRouteHook) {
      removeRouteHook()
      removeRouteHook = null
    }
  }

  return { items, unreadCount, byApp, nextCursor, pending, enabled, refresh, loadMore, markRead, start, stop }
}
