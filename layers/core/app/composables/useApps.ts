// Feeds the launcher (`AppSwitcher.vue` / `AppRail.vue`). Multi-tenant mode
// reads the per-org feed `/api/o/:orgSlug/_apps`; single-tenant mode reads the
// host-level `/api/_apps`. Empty state is fine — the launcher renders correctly
// with zero apps. In multi-tenant mode with no active org (e.g. on `/orgs`,
// `/account/...`) the composable returns an empty org list rather than calling
// the endpoint.
//
// Personal apps (`scope: 'user'`) come from `/api/_personal-apps` in both modes
// and are the same in every org. On a personal app's own pages the org list
// stays on the last active org (the `active-org-slug` cookie), so the rail
// still shows that org's apps.

import { useActiveOrg } from '#tenant'

export interface RailItemEntry {
  id: string
  title: string
  path: string
  icon?: string
  order?: number
}

export interface AppEntry {
  id: string
  title: string
  path: string
  icon?: string
  description?: string
  requiredPermission?: string
  order?: number
  scope?: 'org' | 'user'
  // Present when the app registers rail items; the rail shows these instead of
  // the app's own entry.
  rail?: RailItemEntry[]
}

interface AppsResponse {
  apps: AppEntry[]
}

export async function useApps() {
  const tenancyOn = !!useRuntimeConfig().public.tenancy
  const { user } = useAuth()
  const { slug } = useActiveOrg()
  const chromeOrg = useChromeOrgSlug()
  const orgSlug = computed(() => slug.value ?? chromeOrg.value)

  // Both feeds require auth. Single-tenant: host-level feed (no org).
  // Multi-tenant: per-org feed, which also needs an active slug — empty URL
  // until both are present so we don't 401/404.
  const url = computed(() => {
    if (!user.value) return ''
    if (!tenancyOn) return '/api/_apps'
    return orgSlug.value ? `/api/o/${orgSlug.value}/_apps` : ''
  })

  const personalUrl = computed(() => (user.value ? '/api/_personal-apps' : ''))
  const lastOrg = useCookie<string | null>('active-org-slug')

  // Every composable and watcher runs before the first await: after it, SSR has
  // no Nuxt instance (useCookie/useFetch throw) and watchers outlive the component.
  const orgFetch = useFetch<AppsResponse>(url, {
    default: () => ({ apps: [] as AppEntry[] }),
    watch: [orgSlug, user],
    immediate: !!user.value && (!tenancyOn || !!orgSlug.value),
    key: 'org-apps'
  })
  const personalFetch = useFetch<AppsResponse>(personalUrl, {
    default: () => ({ apps: [] as AppEntry[] }),
    watch: [user],
    immediate: !!user.value,
    key: 'personal-apps'
  })

  // On a personal page the org comes from the last-active-org cookie. If that
  // org is gone for the user (they left it, it was renamed), forget it.
  watch(orgFetch.error, (err) => {
    if (slug.value || !chromeOrg.value) return
    if ((err as { statusCode?: number } | null)?.statusCode === 404) {
      lastOrg.value = null
    }
  })

  const [
    { data, refresh: refreshOrg, pending, error },
    { data: personalData, refresh: refreshPersonal }
  ] = await Promise.all([orgFetch, personalFetch])

  const orgApps = computed<AppEntry[]>(() => (data.value?.apps ?? []).map(a => ({ ...a, scope: 'org' as const })))
  const personalApps = computed<AppEntry[]>(() => (personalData.value?.apps ?? []).map(a => ({ ...a, scope: 'user' as const })))
  const apps = computed<AppEntry[]>(() => [...orgApps.value, ...personalApps.value])

  const refresh = async () => {
    await Promise.all([refreshOrg(), refreshPersonal()])
  }

  return { apps, orgApps, personalApps, refresh, pending, error }
}
