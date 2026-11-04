// Vitest global setup for the `ai` project. Boots the dev host with the test DB
// env and wipes ai-prefixed leftovers on entry/exit. No OPENROUTER_API_KEY is
// set — the client's VITEST short-circuit reports "configured" and stubs the
// network boundary, so suites run without a key.
import { createTest, exposeContextToEnv } from '@nuxt/test-utils/e2e'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  getHostAdminDb,
  closeTestDatabases,
  cleanupTenancyTestData,
  cleanupCoreTestData
} from '@nuxtinator/tenancy/test-helpers'
import { cleanupAiTestData } from './helpers'

const HOST_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../dev')

// NODE_ENV='development' at build + run time (same reason as the other layers'
// global-setup — the mail transports switch on it).
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

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  process.env.APP_DATABASE_URL = process.env.TEST_APP_DATABASE_URL
  process.env.NODE_ENV = 'development'

  await hooks.beforeAll()
  exposeContextToEnv()

  const admin = getHostAdminDb()
  await cleanupAiTestData(admin)
  await cleanupTenancyTestData(admin)
  await cleanupCoreTestData(admin)
}

export async function teardown() {
  try {
    const admin = getHostAdminDb()
    await cleanupAiTestData(admin)
  } finally {
    await closeTestDatabases()
    await hooks.afterAll()
  }
}
