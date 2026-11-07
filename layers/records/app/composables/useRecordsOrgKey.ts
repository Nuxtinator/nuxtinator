// Cache key for org-scoped client state: the active org slug from the route,
// or '' outside an org context (single mode, global routes). Org switching is
// an SPA navigation — useState and module-level caches survive it — so every
// client cache of org-scoped data (user directory, schema catalog, field
// settings) must be keyed by this value; an unkeyed cache serves one org's
// data inside another.

export function useRecordsOrgKey() {
  const route = useRoute()
  return computed(() => {
    const raw = route.params?.orgSlug
    if (typeof raw === 'string' && raw.length > 0) return raw
    if (Array.isArray(raw) && typeof raw[0] === 'string' && raw[0].length > 0) return raw[0]
    return ''
  })
}
