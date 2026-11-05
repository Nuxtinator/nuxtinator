import { useMaybeActiveOrg } from '#tenant'

export interface PickableTeam {
  id: string
  name: string
  archived: boolean
  mine: boolean
}

interface TeamsResponse {
  mode: 'audiences' | 'teams'
  teams: PickableTeam[]
}

// The teams the caller can pick in the active org for `appId`'s content, and
// whether the org's groups run as teams at all. Refetches when the org changes.
export function useTeams(appId: string) {
  const { slug } = useMaybeActiveOrg()
  const { data, refresh, pending } = useAsyncData<TeamsResponse>(
    () => `teams-${appId}-${slug.value ?? ''}`,
    () => $fetch<TeamsResponse, string>('/api/teams', { query: { app: appId } }),
    { watch: [slug], default: () => ({ mode: 'audiences' as const, teams: [] }) }
  )
  return {
    mode: computed(() => data.value?.mode ?? 'audiences'),
    teams: computed(() => data.value?.teams ?? []),
    refresh,
    pending
  }
}

// "Show all teams" for `appId`, kept in a cookie the server reads. Honoured
// only for holders of the app's `all_teams` permission.
export function useShowAllTeams(appId: string) {
  const prefix = useRuntimeConfig().public.cookiePrefix || ''
  const cookie = useCookie<string | null>(`${prefix}all-teams-${appId}`, {
    path: '/',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365
  })
  return computed<boolean>({
    get: () => cookie.value === '1' || (cookie.value as unknown) === 1,
    set: (on: boolean) => { cookie.value = on ? '1' : null }
  })
}
