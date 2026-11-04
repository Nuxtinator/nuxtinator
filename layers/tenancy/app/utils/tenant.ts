// Multi-mode `#tenant` kernel — client side. Overrides the host's single-mode
// kernel via the alias module in `optional-tenancy/modules/tenant-kernel.ts`.

import type { ComputedRef } from 'vue'
import { useRoute, useState } from '#imports'

export interface ActiveOrg {
  slug: ComputedRef<string | null>
  isInOrg: ComputedRef<boolean>
  id: ComputedRef<string>
  role: ComputedRef<string>
}

// Reads the active org from the route. The slug is the source of truth;
// `id` and `role` come from the user's orgs map populated by
// `tenant-orgs-hydrate.client.ts` at boot. All return values are computed
// refs so callers can `watch` them or pass into `useFetch`'s `watch:` option.
//
// Future subdomain mode would read from `window.location.hostname` for the
// slug without changing any caller code.
export function useActiveOrg(): ActiveOrg {
  const route = useRoute()
  const orgs = useState<Record<string, { id: string, role: string }>>('tenant:orgs', () => ({}))

  const slug = computed<string | null>(() => {
    const raw = route.params?.orgSlug
    if (typeof raw === 'string' && raw.length > 0) return raw
    if (Array.isArray(raw) && raw.length > 0) return raw[0]!
    return null
  })
  const isInOrg = computed(() => slug.value !== null)
  const id = computed(() => (slug.value && orgs.value[slug.value]?.id) || '')
  const role = computed(() => (slug.value && orgs.value[slug.value]?.role) || '')

  return { slug, isInOrg, id, role }
}

// Same shape as `useActiveOrg`. Exists so app code that explicitly opts-in
// to "this might run on a global route" reads naturally.
export const useMaybeActiveOrg = useActiveOrg

// Source-of-truth-as-string-or-null, for code that needs the value at call
// time rather than a Vue ref (route guard, upload helpers).
export function getActiveSlug(): string | null {
  const route = useRoute()
  const raw = route.params?.orgSlug
  if (typeof raw === 'string' && raw.length > 0) return raw
  if (Array.isArray(raw) && raw.length > 0) return raw[0]!
  return null
}

// Convenience wrapper — adds `X-Active-Org` to fetches. Equivalent to plain
// `$fetch`, whose instance the `tenant-fetch-template` module builds the header
// injection into; exists so app code can grep for it explicitly.
export const useTenantFetch = $fetch
