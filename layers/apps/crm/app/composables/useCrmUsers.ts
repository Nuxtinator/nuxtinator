// Org user directory for user_select fields: one shared fetch of the user
// picker endpoint, cached in useState so formatters, avatar cells, and
// pickers all resolve ids from the same copy. Every cache is keyed by the
// active org (useCrmOrgKey) — org switching is an SPA navigation, so an
// unkeyed copy would serve one org's directory inside another.
//
// The directory is one page of the org's members, which is the right list to
// pick from but not enough to *name* people: a record can reference anyone.
// Ids resolved by `ensureUserIds` are cached beside the directory rather than
// inside it, so naming someone never quietly enlarges what pickers offer.

/** A user as served by GET /api/crm/users. */
export interface CrmUser {
  id: string
  name: string
  email: string
  avatarUrl: string | null
}

// In-flight request dedupe, per org. SSR is off, so plain module state is safe.
const usersPromises = new Map<string, Promise<void>>()
// Ids currently being resolved, per org — keeps concurrent callers asking for
// overlapping ids from each fetching the overlap.
const idsInFlight = new Map<string, Set<string>>()
// The endpoint resolves at most this many ids per call.
const ID_CHUNK = 100

function inFlightFor(key: string): Set<string> {
  let set = idsInFlight.get(key)
  if (!set) {
    set = new Set<string>()
    idsInFlight.set(key, set)
  }
  return set
}

export function useCrmUsers() {
  const cache = useState<Record<string, CrmUser[]>>('crm:users', () => ({}))
  const resolved = useState<Record<string, Record<string, CrmUser>>>('crm:users-by-id', () => ({}))
  const orgKey = useCrmOrgKey()

  const users = computed(() => cache.value[orgKey.value] ?? [])
  const byId = computed(() => {
    const map = new Map<string, CrmUser>()
    for (const user of users.value) map.set(user.id, user)
    for (const user of Object.values(resolved.value[orgKey.value] ?? {})) map.set(user.id, user)
    return map
  })

  // The org is captured before the request and the response is stored under
  // it, so a fetch that resolves after an org switch can't pollute the new
  // org's slot.
  async function fetchUsers(key: string): Promise<void> {
    const res = await $fetch<{ items: CrmUser[] }>('/api/crm/users', { query: { limit: 50 } })
    cache.value = { ...cache.value, [key]: res.items }
  }

  /** Fetches the directory once per org; concurrent callers share the request. */
  function ensureUsers(): Promise<void> {
    const key = orgKey.value
    if (key in cache.value) return Promise.resolve()
    let inflight = usersPromises.get(key)
    if (!inflight) {
      inflight = fetchUsers(key).finally(() => {
        usersPromises.delete(key)
      })
      usersPromises.set(key, inflight)
    }
    return inflight
  }

  // Same org-capture rule as fetchUsers: results land under the org that was
  // active when the request went out.
  async function fetchUsersByIds(key: string, ids: string[]): Promise<void> {
    const found: CrmUser[] = []
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const chunk = ids.slice(i, i + ID_CHUNK)
      const res = await $fetch<{ items: CrmUser[] }>('/api/crm/users', {
        query: { ids: chunk.join(',') }
      })
      found.push(...res.items)
    }
    if (found.length === 0) return
    const slot = { ...(resolved.value[key] ?? {}) }
    for (const user of found) slot[user.id] = user
    resolved.value = { ...resolved.value, [key]: slot }
  }

  /**
   * Names the given user ids, fetching only those not already known. Callers
   * holding ids from record data use this instead of `ensureUsers`, which
   * loads a page of the directory and so can't name everyone.
   */
  function ensureUserIds(ids: string[]): Promise<void> {
    const key = orgKey.value
    const known = byId.value
    const pending = inFlightFor(key)
    const missing = [...new Set(ids)].filter(id => id && !known.has(id) && !pending.has(id))
    if (missing.length === 0) return Promise.resolve()
    for (const id of missing) pending.add(id)
    return fetchUsersByIds(key, missing).finally(() => {
      for (const id of missing) pending.delete(id)
    })
  }

  /** Typeahead over the directory; an empty query returns the cached list. */
  async function searchUsers(q: string): Promise<CrmUser[]> {
    const query = q.trim()
    if (!query) {
      await ensureUsers()
      return users.value
    }
    const res = await $fetch<{ items: CrmUser[] }>('/api/crm/users', { query: { q: query, limit: 20 } })
    return res.items
  }

  /** Display name for a user id, or null when the id isn't in the cache. */
  function userName(id: string): string | null {
    return byId.value.get(id)?.name ?? null
  }

  return { users, byId, ensureUsers, ensureUserIds, searchUsers, userName }
}
