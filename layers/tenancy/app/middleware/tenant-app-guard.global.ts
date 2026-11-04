// Redirects to the org home (its app list) when navigating into an app that is
// disabled for the org, or whose `requiredPermission` the user lacks. The route
// maps to the app with the longest matching registered path (same rule as
// `useActiveApp`); a page can name its app with `definePageMeta({ appId })`.
//
// UX layer only — the API gate in `withOrgContext({ appId })` stays
// authoritative. If the app map can't be fetched (offline PWA, network error)
// the page loads, so offline-capable apps still open.
import type { AppAccessEntry } from '../utils/app-access'
import { invalidateAppAccess, useAppAccessCache } from '../utils/app-access'

const ORG_RE = /^\/@([^/]+)(\/.*)?$/

function matchApp(apps: AppAccessEntry[], path: string): AppAccessEntry | null {
  let best: AppAccessEntry | null = null
  for (const app of apps) {
    if (path === app.path || path.startsWith(app.path + '/')) {
      if (!best || app.path.length > best.path.length) best = app
    }
  }
  return best
}

export default defineNuxtRouteMiddleware(async (to) => {
  // Host admins toggle apps under /admin; refetch on the way back into an org.
  if (to.path === '/admin' || to.path.startsWith('/admin/')) {
    invalidateAppAccess()
    return
  }

  const match = to.path.match(ORG_RE)
  if (!match) return
  const slug = match[1]!
  const rest = match[2] ?? '/'

  const cache = useAppAccessCache()
  let apps = cache.value[slug]
  if (!apps) {
    try {
      const res = await $fetch<{ apps: AppAccessEntry[] }>(`/api/o/${slug}/_app-access`)
      apps = res.apps ?? []
      cache.value = { ...cache.value, [slug]: apps }
    } catch {
      return
    }
  }

  const app = typeof to.meta.appId === 'string'
    ? apps.find(a => a.id === to.meta.appId) ?? null
    : matchApp(apps, rest)
  if (!app) return

  if (!app.enabled || !app.permitted) return navigateTo(launcherPath(slug))
})
