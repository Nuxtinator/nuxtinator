// Vitest global setup for the `inbox` project. Boots the dev host with the
// test DB env, wipes inbox-prefixed leftovers on entry/exit. The webhook
// signing key and a fast send sweep are pinned here so the fixture builder
// signs with a known key and queued sends become observable within a test's
// patience.
import { createTest, exposeContextToEnv } from '@nuxt/test-utils/e2e'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  getHostAdminDb,
  closeTestDatabases,
  cleanupInboxTestData,
  cleanupTenancyTestData,
  cleanupCoreTestData,
  clearMailhog,
  INBOX_TEST_SIGNING_KEY,
  INBOX_TEST_SHARED_DOMAIN
} from './helpers'

const HOST_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../dev')

// NODE_ENV='development' at build + run time so the mail transports route to
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
      'TEST_DATABASE_URL and TEST_APP_DATABASE_URL must be set in dev/.env. Run scripts/setup-test-db.sh.'
    )
  }

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  process.env.APP_DATABASE_URL = process.env.TEST_APP_DATABASE_URL
  process.env.NODE_ENV = 'development'
  process.env.MAILGUN_WEBHOOK_SIGNING_KEY = INBOX_TEST_SIGNING_KEY
  process.env.INBOX_SEND_SWEEP_SECONDS = '2'
  // Each test org claims its own inbound domain via a core_settings override,
  // keeping org routing assertions deterministic. INBOX_DOMAIN is the shared
  // slug-address domain, which only orgs without that override sit on.
  process.env.INBOX_DOMAIN = INBOX_TEST_SHARED_DOMAIN
  process.env.INBOX_CONTACT_ADDRESS = ''
  process.env.INBOX_SLUG_ADDRESSES = 'true'

  await hooks.beforeAll()
  exposeContextToEnv()

  const admin = getHostAdminDb()
  await cleanupInboxTestData(admin)
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
    await cleanupInboxTestData(admin)
  } finally {
    await closeTestDatabases()
    await hooks.afterAll()
  }
}
