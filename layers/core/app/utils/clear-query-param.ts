// Removes one-shot status params (`?link=`, `?email_change=`) once shown. Each
// replace waits for the previous one and drops every key cleared so far.
const clearedKeys = new Set<string>()
let lastReplace: Promise<unknown> = Promise.resolve()

export function clearQueryParam(key: string): void {
  const router = useRouter()
  clearedKeys.add(key)
  lastReplace = lastReplace.then(() => {
    const current = router.currentRoute.value.query
    if (![...clearedKeys].some(k => k in current)) return
    const query = Object.fromEntries(Object.entries(current).filter(([k]) => !clearedKeys.has(k)))
    return router.replace({ query })
  }).catch(() => {})
}
