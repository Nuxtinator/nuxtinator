import { defineNuxtModule } from '@nuxt/kit'
import type { NuxtPage } from 'nuxt/schema'

// Doubles app-layer routes under `/@:orgSlug/<path>` so app layers don't have
// to write tenancy-aware page files. App authors ship pages at
// `app/pages/<app>/...`; this hook adds parallel `/@:orgSlug/<app>/...`
// aliases pointing at the same components.
//
// Routes excluded from doubling:
//   - The tenancy layer's own pages already living under `/@:orgSlug/`.
//   - System routes: /admin, /account, /login, /register, /reset-password,
//     /accept-invite, /orgs, /. These are global; no slug needed.
//   - /dashboard: the tenancy layer ships its own `/@:orgSlug/dashboard`.
//   - 404 / catch-alls.
//
// The original (un-prefixed) route stays in the table; the router guard
// redirects it to the active-org variant when the user is in an org context.

const SYSTEM_PREFIXES = [
  '/admin',
  '/account',
  '/login',
  '/register',
  '/reset-password',
  '/accept-invite',
  '/orgs',
  '/dashboard',
  '/kitchen'
]

function shouldDouble(p: NuxtPage): boolean {
  if (!p.path) return false
  if (p.path === '/') return false
  if (p.path.startsWith('/@:orgSlug')) return false
  for (const prefix of SYSTEM_PREFIXES) {
    if (p.path === prefix || p.path.startsWith(prefix + '/')) return false
  }
  return true
}

export default defineNuxtModule({
  meta: { name: 'tenancy/pages-extend' },
  setup(_, nuxt) {
    nuxt.hook('pages:extend', (pages) => {
      const additions: NuxtPage[] = []
      for (const p of pages) {
        if (!shouldDouble(p)) continue
        additions.push({
          ...p,
          path: `/@:orgSlug${p.path}`,
          name: p.name ? `${p.name}-tenant` : undefined,
          children: p.children
        })
      }
      pages.push(...additions)
    })
  }
})
