// Record-type catalog + per-type field settings, fetched lazily and cached
// in useState so every component in the tree shares one copy. Every cache is
// keyed by the active org (useCrmOrgKey) — org switching is an SPA
// navigation, so an unkeyed copy would serve one org's schema inside another.

import type { CrmFieldSetting, CrmTypeSections } from '../utils/field-kinds'

/** A record type as served by GET /api/crm/schema/types. */
export interface CrmTypeSummary {
  key: string
  label: string
  labelSingular: string
  icon: string | null
  hidden: boolean
  custom: boolean
  orphan: boolean
  /** Field key promoted to the status column, or null when the type has none. */
  statusField: string | null
  /** Field key picked to hold why a closed record was closed, or null. */
  closedReasonField: string | null
  /** The caller's type-evaluator answers — the server is the only truthful source. */
  canRead: boolean
  canCreate: boolean
}

/** Response of GET /api/crm/schema/types/:type/fields. */
export interface CrmTypeFields {
  sections: CrmTypeSections
  /** Field key promoted to the status column, or null when the type has none. */
  statusField: string | null
  /** Reason field asked for when closing; null unless the type can be closed with a reason. */
  closedReasonField: string | null
  fields: CrmFieldSetting[]
}

// In-flight request dedupe, keyed like the caches (org for the catalog,
// org:type for fields). SSR is off, so plain module state is safe.
const typesPromises = new Map<string, Promise<void>>()
const fieldsPromises = new Map<string, Promise<CrmTypeFields>>()

export function useCrmTypes() {
  const typesCache = useState<Record<string, CrmTypeSummary[]>>('crm:types', () => ({}))
  const pending = useState<boolean>('crm:types-pending', () => false)
  const fieldsCache = useState<Record<string, CrmTypeFields>>('crm:fields', () => ({}))
  const orgKey = useCrmOrgKey()

  const types = computed(() => typesCache.value[orgKey.value] ?? [])

  // Hidden/orphan/non-readable entries come back for schema managers;
  // navigation only ever shows the visible, readable ones.
  const visibleTypes = computed(() => types.value.filter(t => !t.hidden && !t.orphan && t.canRead))

  // The org is captured before the request and the response is stored under
  // it, so a fetch that resolves after an org switch can't pollute the new
  // org's slot.
  async function fetchTypes(key: string): Promise<void> {
    pending.value = true
    try {
      const res = await $fetch<{ types: CrmTypeSummary[] }>('/api/crm/schema/types')
      typesCache.value = { ...typesCache.value, [key]: res.types }
    } finally {
      pending.value = false
    }
  }

  /** Fetches the type catalog once per org; concurrent callers share the request. */
  function ensureTypes(): Promise<void> {
    const key = orgKey.value
    if (key in typesCache.value) return Promise.resolve()
    let inflight = typesPromises.get(key)
    if (!inflight) {
      inflight = fetchTypes(key).finally(() => {
        typesPromises.delete(key)
      })
      typesPromises.set(key, inflight)
    }
    return inflight
  }

  /** Field settings for one type, fetched on first use and cached per org. */
  function getFields(typeKey: string): Promise<CrmTypeFields> {
    const key = `${orgKey.value}:${typeKey}`
    const hit = fieldsCache.value[key]
    if (hit) return Promise.resolve(hit)
    let inflight = fieldsPromises.get(key)
    if (!inflight) {
      inflight = $fetch<CrmTypeFields>(`/api/crm/schema/types/${typeKey}/fields`)
        .then((res) => {
          fieldsCache.value = { ...fieldsCache.value, [key]: res }
          return res
        })
        .finally(() => {
          fieldsPromises.delete(key)
        })
      fieldsPromises.set(key, inflight)
    }
    return inflight
  }

  /** Drops the active org's caches and refetches its catalog. */
  async function refresh(): Promise<void> {
    const key = orgKey.value
    const nextFields: Record<string, CrmTypeFields> = {}
    for (const [k, v] of Object.entries(fieldsCache.value)) {
      if (!k.startsWith(`${key}:`)) nextFields[k] = v
    }
    fieldsCache.value = nextFields
    const nextTypes = { ...typesCache.value }
    delete nextTypes[key]
    typesCache.value = nextTypes
    await ensureTypes()
  }

  return { types, visibleTypes, pending, ensureTypes, getFields, refresh }
}

// Builds an app-local path that keeps the multi-tenant org prefix on
// internal navigation (same pattern as messages' pathFor). In single mode
// there is no orgSlug param and the plain path comes back.
export function useCrmPath() {
  const route = useRoute()
  return (path: string): string => {
    const raw = route.params?.orgSlug
    const slug = typeof raw === 'string' && raw.length > 0
      ? raw
      : (Array.isArray(raw) && raw.length > 0 ? raw[0] : null)
    return slug ? `/@${slug}/crm${path}` : `/crm${path}`
  }
}
