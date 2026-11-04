import type { AppEntry } from './useApps'

// Resolves the "current app" from the route by matching the longest app
// path prefix, ignoring any `/@<slug>` org prefix. Returns null when not
// inside any registered app.
export function useActiveApp(apps: Ref<AppEntry[]> | ComputedRef<AppEntry[]>) {
  const route = useRoute()

  return computed<AppEntry | null>(() => matchAppByPath(apps.value, route.path))
}
