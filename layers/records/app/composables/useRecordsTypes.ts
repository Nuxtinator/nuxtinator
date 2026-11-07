// Record-type catalog + per-type field settings, fetched lazily and cached
// in useState so every component in the tree shares one copy. Every cache is
// keyed by the active org (useRecordsOrgKey) — org switching is an SPA
// navigation, so an unkeyed copy would serve one org's schema inside another.

import { getRecordsTypeRoute } from '#records'
import type { RecordsCardLayout } from '#records'
import type { RecordsFieldSetting, RecordsTypeSections } from '../utils/field-kinds'

/** A record type as served by GET /api/records/schema/types. */
export interface RecordsTypeSummary {
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
  /** Whether a record on a shared board becomes visible to the board's viewers. */
  boardsGrantVisibility: boolean
  /** Default card layout boards and tables over this type start from. */
  card: RecordsCardLayout | null
  /** The caller's type-evaluator answers — the server is the only truthful source. */
  canRead: boolean
  canCreate: boolean
  canViewAll: boolean
}

/** Response of GET /api/records/schema/types/:type/fields. */
export interface RecordsTypeFields {
  sections: RecordsTypeSections
  /** Field key promoted to the status column, or null when the type has none. */
  statusField: string | null
  /** Reason field asked for when closing; null unless the type can be closed with a reason. */
  closedReasonField: string | null
  fields: RecordsFieldSetting[]
}

// In-flight request dedupe, keyed like the caches (org for the catalog,
// org:type for fields). SSR is off, so plain module state is safe.
const typesPromises = new Map<string, Promise<void>>()
const fieldsPromises = new Map<string, Promise<RecordsTypeFields>>()

export function useRecordsTypes() {
  const typesCache = useState<Record<string, RecordsTypeSummary[]>>('records:types', () => ({}))
  const pending = useState<boolean>('records:types-pending', () => false)
  const fieldsCache = useState<Record<string, RecordsTypeFields>>('records:fields', () => ({}))
  const orgKey = useRecordsOrgKey()

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
      const res = await $fetch<{ types: RecordsTypeSummary[] }>('/api/records/schema/types')
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
  function getFields(typeKey: string): Promise<RecordsTypeFields> {
    const key = `${orgKey.value}:${typeKey}`
    const hit = fieldsCache.value[key]
    if (hit) return Promise.resolve(hit)
    let inflight = fieldsPromises.get(key)
    if (!inflight) {
      inflight = $fetch<RecordsTypeFields>(`/api/records/schema/types/${typeKey}/fields`)
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
    const nextFields: Record<string, RecordsTypeFields> = {}
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

function orgPrefix(raw: unknown): string {
  const slug = typeof raw === 'string' && raw.length > 0
    ? raw
    : (Array.isArray(raw) && raw.length > 0 ? raw[0] : null)
  return slug ? `/@${slug}` : ''
}

// Builds an app-local path under /records that keeps the multi-tenant org
// prefix on internal navigation (same pattern as messages' pathFor). In
// single mode there is no orgSlug param and the plain path comes back.
export function useRecordsPath() {
  const route = useRoute()
  return (path: string): string => `${orgPrefix(route.params?.orgSlug)}/records${path}`
}

// Builds a path under the record-type settings: the org settings shell in
// multi mode, the host admin shell in single mode.
export function useRecordsSettingsPath() {
  const route = useRoute()
  const tenancy = useRuntimeConfig().public.tenancy
  return (path = ''): string => tenancy
    ? `${orgPrefix(route.params?.orgSlug)}/settings/records${path}`
    : `/admin/records${path}`
}

// The list path for a type (no id) or a record's detail path, honoring the
// type routes other layers register (contacts live under /crm/contacts).
export function useRecordsTypePath() {
  const route = useRoute()
  return (typeKey: string, recordId?: string): string => {
    const base = getRecordsTypeRoute(typeKey)?.base ?? `/records/${typeKey}`
    return `${orgPrefix(route.params?.orgSlug)}${base}${recordId ? `/${recordId}` : ''}`
  }
}
