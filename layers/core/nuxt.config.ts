// Core layer — the always-on foundation that every project built from this
// stack extends. Provides:
//
//   - Auth flows (login, register, password reset, accept-invite, verify)
//   - Profile + admin-shell pages and APIs
//   - The 6 runtime registries (apps, nav, admin-sections, permissions,
//     default-grants, static-roles)
//   - Single-mode `#tenant` kernel (multi-mode tenancy overrides via the
//     optional `tenancy` layer)
//   - Migration runner module + 5 core migrations (users, password reset,
//     activity logs, custom roles, apps catalog)
//   - Activity logger, rate limiter, secret crypto, storage, slug validator
//   - Launcher chrome (AppRail, AppSidebar, layouts, composables)
//   - bootstrap-admin script
//
// Files in this layer can be overridden by the host (page customizations,
// branding, etc.) — Nuxt's layer system makes the host's files higher
// priority.
import { fileURLToPath } from 'node:url'

const layerRoot = fileURLToPath(new URL('.', import.meta.url))

export default defineNuxtConfig({
  modules: [
    fileURLToPath(new URL('./modules/migrations.ts', import.meta.url)),
    fileURLToPath(new URL('./modules/tenant-kernel.ts', import.meta.url)),
    fileURLToPath(new URL('./modules/email-kernel.ts', import.meta.url)),
    fileURLToPath(new URL('./modules/ai-kernel.ts', import.meta.url)),
    fileURLToPath(new URL('./modules/layer-versions.ts', import.meta.url)),
    '@nuxtjs/i18n'
  ],

  // Layers opt into translation by declaring `i18n.locales` (with `file`) in
  // their own nuxt.config and shipping `i18n/locales/<file>`; the module merges
  // every layer's locales and messages. `no_prefix` keeps URLs unchanged so the
  // tenancy layer's `/@:orgSlug` route aliases aren't multiplied per locale.
  i18n: {
    strategy: 'no_prefix',
    defaultLocale: 'en',
    locales: [{ code: 'en', language: 'en', name: 'English' }],
    detectBrowserLanguage: {
      useCookie: true,
      cookieKey: 'i18n_locale'
    }
  },

  css: [fileURLToPath(new URL('./app/assets/css/main.css', import.meta.url))],

  app: {
    head: {
      // Show correct color on first paint before nuxt loads 
      style: [
        {
          innerHTML: ':root{background-color:#fff}:root.dark{background-color:#171717}'
        }
      ]
    }
  },

  alias: {
    // `#core/...` resolves to this layer's root, so cross-layer code can
    // import e.g. `#core/server/utils/database` without depending on whether
    // host's rootDir is the repo root or a subdir.
    '#core': layerRoot.replace(/\/$/, ''),
    '#permissions': fileURLToPath(new URL('./app/utils/permissions.ts', import.meta.url))
  },

  // fetchdts-based $fetch typing; the legacy InternalApi engine hits TS2589 at this app's route count.
  experimental: {
    routeTypedFetch: true
  },

  nitro: {
    typescript: {
      tsConfig: {
        compilerOptions: {
          paths: {
            '#core/*': [`${layerRoot}*`],
            '#permissions': [`${layerRoot}app/utils/permissions.ts`]
          }
        }
      }
    }
  },

  // Feature flag: whether the tenancy layer is loaded. Default off; the
  // tenancy layer's nuxt.config flips it to true. Code in core that touches
  // tenancy-only tables (orgs, memberships) or endpoints (/api/admin/orgs/*)
  // must check `useRuntimeConfig().public.tenancy` and degrade gracefully.
  runtimeConfig: {
    // Which reverse proxies may speak for the client in X-Forwarded-For
    // (NUXT_TRUSTED_PROXIES): comma-separated presets (loopback, private,
    // cloudflare) and CIDRs. getClientIp skips these addresses and keys on the
    // first one that isn't. See documentation/deploy-behind-a-proxy.md.
    trustedProxies: 'loopback,private,cloudflare',
    public: {
      // Prepended to session and active-org cookie names
      // (NUXT_PUBLIC_COOKIE_PREFIX) so apps on the same hostname don't share them.
      cookiePrefix: '',
      tenancy: false,
      // The page that holds the user's account settings. Email-change and
      // provider-link flows return here; a host with its own account page sets it.
      accountPath: '/account',
      // Personal app layers (`registerApp({ scope: 'user' })`) add
      // `{ <appId>: '<path>' }` here. Tenancy keeps these pages out of the
      // `/@:orgSlug` routes and the launcher keeps them out of org feeds.
      personalApps: {} as Record<string, string>
    }
  }
})
