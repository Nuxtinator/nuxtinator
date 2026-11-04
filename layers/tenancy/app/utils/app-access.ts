// Per-org cache of `/api/o/:slug/_app-access`, read by `tenant-app-guard.global.ts`.
import { useState } from '#imports'

export interface AppAccessEntry {
  id: string
  title: string
  path: string
  enabled: boolean
  permitted: boolean
}

export function useAppAccessCache() {
  return useState<Record<string, AppAccessEntry[]>>('tenant:app-access', () => ({}))
}

// Drops the cached app map for one org (or every org) so the next navigation refetches it.
export function invalidateAppAccess(slug?: string) {
  const cache = useAppAccessCache()
  if (!slug) {
    cache.value = {}
    return
  }
  const next = { ...cache.value }
  delete next[slug]
  cache.value = next
}
