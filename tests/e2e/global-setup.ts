// Playwright global setup. The webServer entry in playwright.config.ts boots
// Nuxt against the test DB; this hook just clears prior test data so a stale
// run doesn't pollute the next one. MailHog is also reset.
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getHostAdminDb,
  closeTestDatabases,
  cleanupCoreTestData,
  clearMailhog
} from '@nuxtinator/core/test-helpers'
import { cleanupTenancyTestData } from '@nuxtinator/tenancy/test-helpers'

const __dirname = dirname(fileURLToPath(import.meta.url))
loadDotenv({ path: resolve(__dirname, '../../dev/.env') })

export default async function globalSetup() {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL must be set in dev/.env')
  }
  const sql = getHostAdminDb()
  await cleanupTenancyTestData(sql)
  await cleanupCoreTestData(sql)
  try {
    await clearMailhog()
  } catch {
    // not strictly required
  }
  await closeTestDatabases()
}
