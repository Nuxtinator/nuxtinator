// Boots Nuxt against the test DB and cleans layer-prefixed data on entry +
// exit. Same shape as layers/tenancy/tests/global-setup.ts.
import { createTest, exposeContextToEnv } from '@nuxt/test-utils/e2e'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { getHostAdminDb, closeTestDatabases, cleanupCoreTestData, clearMailhog } from '@nuxtinator/core/test-helpers'
import { cleanupTenancyTestData } from '@nuxtinator/tenancy/test-helpers'
import { cleanupVideosTestData } from './helpers'

const HOST_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../dev')

const hooks = createTest({
  rootDir: HOST_DIR,
  server: true,
  browser: false,
  env: { NODE_ENV: 'development' },
  nuxtConfig: {
    vite: { define: { 'process.env.NODE_ENV': JSON.stringify('development') } },
    nitro: { replace: { 'process.env.NODE_ENV': JSON.stringify('development') } }
  }
})

export async function setup() {
  if (!process.env.TEST_DATABASE_URL || !process.env.TEST_APP_DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL and TEST_APP_DATABASE_URL must be set in host/.env. Run scripts/setup-test-db.sh.')
  }
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  process.env.APP_DATABASE_URL = process.env.TEST_APP_DATABASE_URL
  process.env.NODE_ENV = 'development'

  await hooks.beforeAll()
  exposeContextToEnv()

  const sql = getHostAdminDb()
  await cleanupVideosTestData(sql)
  await cleanupTenancyTestData(sql)
  await cleanupCoreTestData(sql)
  try { await clearMailhog() } catch { /* optional */ }
}

export async function teardown() {
  try {
    const sql = getHostAdminDb()
    await cleanupVideosTestData(sql)
  } finally {
    await closeTestDatabases()
    await hooks.afterAll()
  }
}
