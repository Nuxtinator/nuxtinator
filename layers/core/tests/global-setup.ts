// Vitest global setup for the `core` project. Boots a Nuxt server (via
// @nuxt/test-utils/e2e) pointed at the test DB. Migrations run on first boot
// via the core layer's Nitro plugin. Cleans up any leftover test-core-* data
// from a prior aborted run.
import { createTest, exposeContextToEnv } from '@nuxt/test-utils/e2e'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  getHostAdminDb,
  closeTestDatabases,
  cleanupCoreTestData,
  clearMailhog
} from './helpers'

// Resolve dev/ relative to this file: layers/core/tests/global-setup.ts → ../../host
const HOST_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../dev')

// NODE_ENV must be 'development' both at build time (Vite inlines
// `process.env.NODE_ENV` into the bundle, so the email layer's
// `isDevelopment` check would otherwise be permanently false) AND at server
// runtime. We pin both: vite's `define` for the build, and `env.NODE_ENV`
// for the spawned server process.
const hooks = createTest({
  rootDir: HOST_DIR,
  server: true,
  browser: false,
  env: { NODE_ENV: 'development' },
  nuxtConfig: {
    vite: {
      define: {
        'process.env.NODE_ENV': JSON.stringify('development')
      }
    },
    nitro: {
      replace: {
        'process.env.NODE_ENV': JSON.stringify('development')
      }
    }
  }
})

export async function setup() {
  if (!process.env.TEST_DATABASE_URL || !process.env.TEST_APP_DATABASE_URL) {
    throw new Error(
      'TEST_DATABASE_URL and TEST_APP_DATABASE_URL must be set in dev/.env. Run scripts/setup-test-db.sh.'
    )
  }

  // Force the spawned Nuxt server to talk to the test DB. The migrations
  // plugin uses DATABASE_URL (host_admin); the app's `db` uses APP_DATABASE_URL
  // (app_user). Email layer routes to MailHog only when NODE_ENV !== 'production'.
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  process.env.APP_DATABASE_URL = process.env.TEST_APP_DATABASE_URL
  process.env.NODE_ENV = 'development'

  await hooks.beforeAll()
  exposeContextToEnv()

  const admin = getHostAdminDb()
  await cleanupCoreTestData(admin)

  // MailHog state is process-global; start each test run with an empty inbox.
  try {
    await clearMailhog()
  } catch {
    // MailHog isn't strictly required for every core test; surface lazily.
  }
}

export async function teardown() {
  try {
    const admin = getHostAdminDb()
    await cleanupCoreTestData(admin)
  } finally {
    await closeTestDatabases()
    await hooks.afterAll()
  }
}
