import { useActiveOrg } from '#tenant'

export interface NavItem {
  appId: string
  title: string
  path: string
  icon?: string
  requiredPermission?: string
  order?: number
}

interface NavResponse {
  items: NavItem[]
}

export async function useAppNav(appId: MaybeRefOrGetter<string>) {
  const appIdRef = computed(() => toValue(appId))
  const tenancyOn = !!useRuntimeConfig().public.tenancy
  const personalApps = (useRuntimeConfig().public.personalApps ?? {}) as Record<string, string>
  const { user } = useAuth()
  const { slug } = useActiveOrg()
  const isPersonal = computed(() => appIdRef.value in personalApps)

  // Both feeds require auth. Single-tenant: host-level feed (no org).
  // Multi-tenant: per-org feed, which also needs an active slug — empty URL
  // until both are present so we don't 401/404. Personal apps use their own
  // org-less feed in both modes.
  const url = computed(() => {
    if (!user.value) return ''
    if (isPersonal.value) return '/api/_personal-nav'
    if (!tenancyOn) return '/api/_nav'
    return slug.value ? `/api/o/${slug.value}/_nav` : ''
  })

  const { data, refresh, pending, error } = await useFetch<NavResponse>(url, {
    key: 'app-nav',
    query: computed(() => ({ app: appIdRef.value })),
    watch: [appIdRef, slug, user],
    immediate: !!user.value && (!tenancyOn || !!slug.value || isPersonal.value),
    default: () => ({ items: [] as NavItem[] })
  })

  const items = computed<NavItem[]>(() => data.value?.items ?? [])

  return { items, refresh, pending, error }
}
