import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const stubsDir = fileURLToPath(new URL('./tests/stubs', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      // Layer files import consumer-rooted paths via `~~/...`. Map those to
      // the test stubs so the layer's pure-logic units compile in isolation
      // without booting Nuxt.
      '~~/app/utils/permissions': `${stubsDir}/app/utils/permissions.ts`,
      '~~/server/utils/rbac': `${stubsDir}/server/utils/rbac.ts`,
      '~~/server/utils/activity-logger': `${stubsDir}/server/utils/activity-logger.ts`,
      '~~/server/utils/oauth-bearer': `${stubsDir}/server/utils/oauth-bearer.ts`,
      '~~/server/utils/oauth-config': `${stubsDir}/server/utils/oauth-config.ts`,
      '~~/server/database/schema': `${stubsDir}/server/database/schema.ts`,
      // Layer files import OAuth-layer utilities via `#oauth/*` aliases declared
      // in the OAuth layer's nuxt.config.ts. Vitest doesn't load Nuxt configs,
      // so we mirror those aliases here pointing at the test stubs.
      '#oauth/bearer': `${stubsDir}/server/utils/oauth-bearer.ts`,
      '#oauth/config': `${stubsDir}/server/utils/oauth-config.ts`,
      '#oauth/scopes': `${stubsDir}/server/utils/scopes-registry.ts`,
      // Same for the core layer's `#core/*` alias.
      '#core/app/utils/permissions': `${stubsDir}/app/utils/permissions.ts`,
      '#core/server/utils/permissions-registry': `${stubsDir}/server/utils/permissions-registry.ts`
    }
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    globalSetup: ['./tests/global-setup.ts'],
    // Integration tests boot the fixture consumer and run sequentially —
    // they share the test Postgres and the booted Nuxt server.
    fileParallelism: false,
    // Long timeout for boot-the-Nuxt-fixture init.
    testTimeout: 30_000,
    hookTimeout: 60_000
  }
})
