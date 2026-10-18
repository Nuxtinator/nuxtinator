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

export interface AppEntry {
  id: string
  title: string
  path: string
  icon?: string
  description?: string
  requiredPermission?: string
  order?: number
  scope?: 'org' | 'user'
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

  const { data, refresh: refreshOrg, pending, error } = await useFetch<AppsResponse>(url, {
    default: () => ({ apps: [] as AppEntry[] }),
    watch: [orgSlug, user],
    immediate: !!user.value && (!tenancyOn || !!orgSlug.value),
    key: 'org-apps'
  })

  const personalUrl = computed(() => (user.value ? '/api/_personal-apps' : ''))
  const { data: personalData, refresh: refreshPersonal } = await useFetch<AppsResponse>(personalUrl, {
    default: () => ({ apps: [] as AppEntry[] }),
    watch: [user],
    immediate: !!user.value,
    key: 'personal-apps'
  })

  const orgApps = computed<AppEntry[]>(() => (data.value?.apps ?? []).map(a => ({ ...a, scope: 'org' as const })))
  const personalApps = computed<AppEntry[]>(() => (personalData.value?.apps ?? []).map(a => ({ ...a, scope: 'user' as const })))
  const apps = computed<AppEntry[]>(() => [...orgApps.value, ...personalApps.value])

  const refresh = async () => {
    await Promise.all([refreshOrg(), refreshPersonal()])
  }

  return { apps, orgApps, personalApps, refresh, pending, error }
}
