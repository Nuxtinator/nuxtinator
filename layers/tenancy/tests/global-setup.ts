// Vitest global setup for the `tenancy` project. Same shape as core's:
// boot Nuxt, run migrations, clean tenancy-prefixed data on entry/exit.
import { createTest, exposeContextToEnv } from '@nuxt/test-utils/e2e'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  getHostAdminDb,
  closeTestDatabases,
  cleanupTenancyTestData,
  cleanupCoreTestData,
  clearMailhog
} from './helpers'

const HOST_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../dev')

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
      replace: {
        'process.env.NODE_ENV': JSON.stringify('development')
      }
    }
  }
})

export async function setup() {
  if (!process.env.TEST_DATABASE_URL || !process.env.TEST_APP_DATABASE_URL) {
    throw new Error(
      'TEST_DATABASE_URL and TEST_APP_DATABASE_URL must be set in host/.env. Run scripts/setup-test-db.sh.'
    )
  }

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  process.env.APP_DATABASE_URL = process.env.TEST_APP_DATABASE_URL
  process.env.NODE_ENV = 'development'

  await hooks.beforeAll()
  exposeContextToEnv()

  const admin = getHostAdminDb()
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
    await cleanupTenancyTestData(admin)
  } finally {
    await closeTestDatabases()
    await hooks.afterAll()
  }
}
