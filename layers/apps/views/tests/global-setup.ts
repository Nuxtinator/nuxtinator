// Vitest global setup for the `views` project. Mirrors crm's setup:
// boot Nuxt (the dev host) with the test DB env, wipe any
// views-prefixed leftovers on entry/exit.
import { createTest, exposeContextToEnv } from '@nuxt/test-utils/e2e'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  getHostAdminDb,
  closeTestDatabases,
  cleanupViewsTestData,
  cleanupTenancyTestData,
  cleanupCoreTestData
} from './helpers'

const HOST_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../dev')

// NODE_ENV='development' at build + run time so the email layer routes to
// Mailpit (see core's global-setup.ts for the why).
const hooks = createTest({
  rootDir: HOST_DIR,
  server: true,
  browser: false,
  env: { NODE_ENV: 'development', NUXTINATOR_TEST_FIXTURES: '1' },
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
  await cleanupViewsTestData(admin)
  await cleanupTenancyTestData(admin)
  await cleanupCoreTestData(admin)
}

export async function teardown() {
  try {
    const admin = getHostAdminDb()
    await cleanupViewsTestData(admin)
  } finally {
    await closeTestDatabases()
    await hooks.afterAll()
  }
}
