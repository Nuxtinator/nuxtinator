// Fixture consumer for the MCP-layer integration tests. Extends the core,
// OAuth and MCP layers just like a real consumer would.
//
// Layer paths are resolved to absolute paths at config-load time so Nuxt's
// route/plugin scanner doesn't get confused by relative-path resolution
// from the .nuxt/ vs nuxt.config.ts locations.
import { fileURLToPath } from 'node:url'
import { defineNuxtConfig } from 'nuxt/config'

const coreLayer = fileURLToPath(new URL('../../../../core', import.meta.url))
const oauthLayer = fileURLToPath(new URL('../../../../oauth', import.meta.url))
const mcpLayer = fileURLToPath(new URL('../../..', import.meta.url))

export default defineNuxtConfig({
  extends: [coreLayer, oauthLayer, mcpLayer],

  modules: ['@nuxt/ui'],

  ssr: false,

  devtools: { enabled: false },

  runtimeConfig: {
    oauthConsentCookieSecret: process.env.OAUTH_CONSENT_COOKIE_SECRET || 'test-secret-32-bytes-of-random-stuff',
    oauthAllowDynamicClientRegistration: true,
    mcpServerName: 'mcp-fixture-consumer',
    mcpServerVersion: '0.0.0-test',
    mcpReadScopes: ['pages.view'] as string[],
    mcpRateLimits: {} as Record<string, unknown>,
    mcpAdditionalOrigins: [] as string[],
    public: {
      siteUrl: process.env.NUXT_PUBLIC_SITE_URL || 'http://localhost:3099'
    }
  },

  nitro: {
    storage: {
      cache: { driver: 'memory' }
    }
  },

  compatibilityDate: '2025-01-15'
})
