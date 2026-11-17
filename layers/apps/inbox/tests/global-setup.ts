// Vitest global setup for the `inbox` project. Boots the dev host with the
// test DB env and the fake mail provider registered, wipes inbox-prefixed
// leftovers on entry/exit, and gives the inbox its own mail setup: a
// fake-provider account and a host domain that sends and receives, routed to
// the inbox stream. The account's webhook paths are recorded for the
// fixtures. A fast send sweep is pinned so queued sends become observable
// within a test's patience.
//
// The env account and env domain are left alone: every project's server
// rewrites them on boot, and projects boot in parallel against one database.
// For the same reason sends use the development transport (Mailpit) rather
// than `provider`, whose env-account fingerprint check pauses sends whenever
// another project booted last.
import { createTest, exposeContextToEnv, $fetch } from '@nuxt/test-utils/e2e'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  getHostAdminDb,
  closeTestDatabases,
  cleanupInboxTestData,
  cleanupTenancyTestData,
  cleanupCoreTestData,
  clearMailhog,
  createTestUser,
  getAuthHeaders,
  INBOX_TEST_SIGNING_KEY,
  INBOX_TEST_API_KEY,
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
  process.env.INBOX_SEND_SWEEP_SECONDS = '2'
  process.env.MAIL_FAKE_PROVIDER = '1'
  process.env.INBOX_SLUG_ADDRESSES = 'true'

  await hooks.beforeAll()
  exposeContextToEnv()

  const admin = getHostAdminDb()
  await cleanupInboxTestData(admin)
  await cleanupTenancyTestData(admin)
  await cleanupCoreTestData(admin)
  await setUpInboxMail(admin)

  try {
    await clearMailhog()
  } catch {
    // not required for every test
  }
}

// The inbox's mail account and host domain. Receiving is marked verified
// directly: the probe that verifies it is tested with the kernel.
async function setUpInboxMail(admin: ReturnType<typeof getHostAdminDb>) {
  await removeInboxMail(admin)
  const hostAdmin = await createTestUser(admin, { email: `test-inbox-hostadmin-${Date.now()}@example.com`, is_admin: true })
  const { account } = await $fetch<{ account: { id: string, webhookUrls: { events: string, inbound: string } | null } }>(
    '/api/admin/mail/accounts',
    {
      method: 'POST',
      body: { provider: 'fake', label: 'test-inbox', credentials: { apiKey: INBOX_TEST_API_KEY, signingKey: INBOX_TEST_SIGNING_KEY } },
      ...getAuthHeaders(hostAdmin)
    }
  )
  if (!account.webhookUrls) throw new Error('The inbox test mail account has no webhook URLs')
  const [domain] = await admin<{ id: string }[]>`
    INSERT INTO mail_domains (org_id, source, domain, ownership_status, send_account_id, receive_account_id, setup_mode, send_status, receive_status)
    VALUES (NULL, 'ui', ${INBOX_TEST_SHARED_DOMAIN}, 'verified', ${account.id}, ${account.id}, 'manual', 'verified', 'verified')
    RETURNING id
  `
  await admin`
    INSERT INTO mail_stream_routes (org_id, stream, domain_id) VALUES (NULL, 'inbox', ${domain!.id})
    ON CONFLICT ((coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid)), stream) DO UPDATE SET domain_id = excluded.domain_id
  `
  process.env.INBOX_TEST_MAIL_ACCOUNT_ID = account.id
  process.env.INBOX_TEST_SHARED_DOMAIN_ID = domain!.id
  process.env.INBOX_TEST_MAIL_INBOUND_PATH = new URL(account.webhookUrls.inbound).pathname
  process.env.INBOX_TEST_MAIL_EVENTS_PATH = new URL(account.webhookUrls.events).pathname
}

async function removeInboxMail(admin: ReturnType<typeof getHostAdminDb>) {
  await admin`DELETE FROM mail_domains WHERE org_id IS NULL AND source = 'ui' AND domain LIKE 'test-inbox-%'`
  await admin`DELETE FROM mail_accounts WHERE org_id IS NULL AND source = 'ui' AND label = 'test-inbox'`
}

export async function teardown() {
  try {
    const admin = getHostAdminDb()
    await cleanupInboxTestData(admin)
    await removeInboxMail(admin)
  } finally {
    await closeTestDatabases()
    await hooks.afterAll()
  }
}
