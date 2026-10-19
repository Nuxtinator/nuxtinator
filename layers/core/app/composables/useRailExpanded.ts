const STORAGE_KEY = 'nuxtinator:rail-expanded'

// Whether the desktop rail shows names next to its icons. Starts from
// `appConfig.rail.expanded`; each browser then remembers the user's choice.
export function useRailExpanded() {
  const fallback = useAppConfig().rail?.expanded === true
  const expanded = useState<boolean>('rail-expanded', () => {
    if (!import.meta.client) return fallback
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      return stored === null ? fallback : stored === '1'
    } catch {
      return fallback
    }
  })

  function toggle() {
    expanded.value = !expanded.value
    try {
      localStorage.setItem(STORAGE_KEY, expanded.value ? '1' : '0')
    } catch {
      // Storage unavailable: the choice lasts for this page load only.
    }
  }

  return { expanded: readonly(expanded), toggle }
}
