// Org-prefix-preserving link builder for inbox routes. Takes the full app
// path ('/inbox/…') — unlike useRecordsPath, which prepends its own '/crm'.
export function useInboxPath() {
  const route = useRoute()
  return (path: string): string => {
    const raw = route.params?.orgSlug
    const slug = typeof raw === 'string' && raw.length > 0
      ? raw
      : (Array.isArray(raw) && raw.length > 0 ? raw[0] : null)
    return slug ? `/@${slug}${path}` : path
  }
}
