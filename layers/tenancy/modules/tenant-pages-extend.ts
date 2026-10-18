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
//   - Personal apps (`runtimeConfig.public.personalApps`): the same in every
//     org, so they only live at their bare path.
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

function shouldDouble(p: NuxtPage, personalPaths: string[]): boolean {
  if (!p.path) return false
  if (p.path === '/') return false
  if (p.path.startsWith('/@:orgSlug')) return false
  for (const prefix of [...SYSTEM_PREFIXES, ...personalPaths]) {
    if (p.path === prefix || p.path.startsWith(prefix + '/')) return false
  }
  return true
}

export default defineNuxtModule({
  meta: { name: 'tenancy/pages-extend' },
  setup(_, nuxt) {
    const personalApps = (nuxt.options.runtimeConfig.public.personalApps ?? {}) as Record<string, string>
    const personalPaths = Object.values(personalApps)
    nuxt.hook('pages:extend', (pages) => {
      const additions: NuxtPage[] = []
      for (const p of pages) {
        if (!shouldDouble(p, personalPaths)) continue
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
