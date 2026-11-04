// Org-prefix-preserving link builder: '/helpinator/…' → '/@<slug>/helpinator/…'
// in multi-tenant mode, unchanged in single mode.
export function useHelpinatorPath() {
  const route = useRoute()
  return (path: string): string => {
    const raw = route.params?.orgSlug
    const slug = typeof raw === 'string' && raw.length > 0
      ? raw
      : (Array.isArray(raw) && raw.length > 0 ? raw[0] : null)
    return slug ? `/@${slug}${path}` : path
  }
}
