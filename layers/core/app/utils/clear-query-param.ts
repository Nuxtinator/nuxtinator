// Removes one-shot status parameters (`?link=`, `?email_change=`) from the URL
// once they've been shown, so a reload doesn't show them again. Removals made
// in the same tick go out as one replace, so components clearing different
// keys don't put back each other's.
const pendingKeys = new Set<string>()

export function clearQueryParam(key: string): void {
  const router = useRouter()
  pendingKeys.add(key)
  if (pendingKeys.size > 1) return
  nextTick(() => {
    const query = { ...router.currentRoute.value.query }
    for (const k of pendingKeys) delete query[k]
    pendingKeys.clear()
    router.replace({ query })
  })
}
