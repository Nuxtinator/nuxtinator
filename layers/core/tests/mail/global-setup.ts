// Vitest global setup for the `core-mail` project. Boots Nuxt like core's
// global-setup, but with the mail kernel on the `provider` transport and the
// fake provider as the env account (it delivers to Mailpit). The mail env is
// passed to the spawned server only, so other projects' servers keep theirs.
// Tests reach the server through the URL provided as `coreMailUrl`.
import { createTest } from '@nuxt/test-utils/e2e'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import type { TestProject } from 'vitest/node'
import { getHostAdminDb, closeTestDatabases, clearMailhog } from '../helpers'
import { cleanupCoreMailData, MAIL_ENV } from './helpers'
import { createMailNotesTables, dropMailNotesTables } from './fixtures/notes-tables'

const HOST_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../dev')
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const SHARES = resolve(FIXTURES, 'notes-shares.ts')

declare module 'vitest' {
  interface ProvidedContext {
    coreMailUrl: string
  }
}

const hooks = createTest({
  rootDir: HOST_DIR,
  server: true,
  browser: false,
  env: {
    NODE_ENV: 'development',
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
    APP_DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? '',
    ...MAIL_ENV
  },
  nuxtConfig: {
    vite: {
      define: {
        'process.env.NODE_ENV': JSON.stringify('development')
      }
    },
    nitro: {
      plugins: [resolve(FIXTURES, 'notes-plugin.ts')],
      handlers: [
        { route: '/api/test-core-mail-notes/:id/shares', handler: SHARES },
        { route: '/api/test-core-mail-notes/:id/shares/:shareId', handler: SHARES },
        { route: '/api/test-core-mail-notes/:id/shares/:shareId/resend', handler: SHARES },
        { route: '/api/test-core-mail/send-template', handler: resolve(FIXTURES, 'send-template.ts') }
      ],
      replace: {
        'process.env.NODE_ENV': JSON.stringify('development')
      }
    }
  }
})

let startedAt = new Date()

export async function setup(project: TestProject) {
  if (!process.env.TEST_DATABASE_URL || !process.env.TEST_APP_DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL and TEST_APP_DATABASE_URL must be set in dev/.env. Run scripts/setup-test-db.sh.')
  }
  startedAt = new Date()
  // The same values core's global-setup sets; the build reads them.
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  process.env.APP_DATABASE_URL = process.env.TEST_APP_DATABASE_URL

  await hooks.beforeAll()
  project.provide('coreMailUrl', hooks.ctx.url!)

  const admin = getHostAdminDb()
  await cleanupCoreMailData(admin)
  await createMailNotesTables(admin)

  try {
    await clearMailhog()
  } catch {
    // Mailpit is checked by the tests that need it.
  }
}

export async function teardown() {
  try {
    const admin = getHostAdminDb()
    await cleanupCoreMailData(admin)
    await admin`DELETE FROM mail_outbox WHERE created_at >= ${startedAt} AND status IN ('sent', 'failed')`
    await dropMailNotesTables(admin)
    await admin`DELETE FROM apps WHERE id = 'test-core-mail-notes'`
  } finally {
    await closeTestDatabases()
    await hooks.afterAll()
  }
}
