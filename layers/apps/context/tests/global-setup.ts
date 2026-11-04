// Vitest global setup for the `context` project. Mirrors messages' setup:
// boot Nuxt with the test DB env, wipe any context-prefixed leftovers on
// entry/exit. Assistant tests run against the AI layer's VITEST fake, so no
// model API key is needed.
import { createTest, exposeContextToEnv } from '@nuxt/test-utils/e2e'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  getHostAdminDb,
  closeTestDatabases,
  cleanupContextTestData,
  cleanupTenancyTestData,
  cleanupCoreTestData,
  clearMailhog
} from './helpers'

const TESTS_DIR = dirname(fileURLToPath(import.meta.url))
const HOST_DIR = resolve(TESTS_DIR, '../../../../dev')

// NODE_ENV='development' at build + run time so the email layer routes to
// Mailpit (see core's global-setup.ts for the why).
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
      plugins: [resolve(TESTS_DIR, 'fixtures/register-test-template.ts')],
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

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  process.env.APP_DATABASE_URL = process.env.TEST_APP_DATABASE_URL
  process.env.NODE_ENV = 'development'

  await hooks.beforeAll()
  exposeContextToEnv()

  const admin = getHostAdminDb()
  await cleanupContextTestData(admin)
  await cleanupTenancyTestData(admin)
  await cleanupCoreTestData(admin)

  try {
    await clearMailhog()
  } catch {
    // not required for every test
  }
}

export async function teardown() {
  try {
    const admin = getHostAdminDb()
    await cleanupContextTestData(admin)
  } finally {
    await closeTestDatabases()
    await hooks.afterAll()
  }
}
