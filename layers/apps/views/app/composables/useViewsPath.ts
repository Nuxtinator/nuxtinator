// Builds an app-local path that keeps the multi-tenant org prefix on
// internal navigation (same pattern as the records layer's useRecordsPath). In single mode
// there is no orgSlug param and the plain path comes back.
export function useViewsPath() {
  const route = useRoute()
  return (path: string): string => {
    const raw = route.params?.orgSlug
    const slug = typeof raw === 'string' && raw.length > 0
      ? raw
      : (Array.isArray(raw) && raw.length > 0 ? raw[0] : null)
    return slug ? `/@${slug}/views${path}` : `/views${path}`
  }
}
