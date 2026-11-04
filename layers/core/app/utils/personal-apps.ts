// Whether `path` is one of a personal app's pages. Personal app layers list
// their paths under `runtimeConfig.public.personalApps`; their pages are the
// same in every org, so they never carry an `/@<slug>` prefix.
export function isPersonalAppPath(path: string): boolean {
  const personalApps = (useRuntimeConfig().public.personalApps ?? {}) as Record<string, string>
  return Object.values(personalApps).some(prefix => path === prefix || path.startsWith(prefix + '/'))
}

// The org a page outside any org shows in the chrome: on a personal app's
// pages it's the last active org (the `active-org-slug` cookie), so the rail
// and org switcher keep it while the user is in the app; elsewhere none.
export function useChromeOrgSlug() {
  const route = useRoute()
  const lastOrg = useCookie<string | null>(cookieName('active-org-slug'))
  return computed<string | null>(() => isPersonalAppPath(route.path) ? lastOrg.value ?? null : null)
}
