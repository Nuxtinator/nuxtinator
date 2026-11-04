import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getHostAdminDb,
  closeTestDatabases,
  cleanupCoreTestData
} from '@nuxtinator/core/test-helpers'
import { cleanupTenancyTestData } from '@nuxtinator/tenancy/test-helpers'

const __dirname = dirname(fileURLToPath(import.meta.url))
loadDotenv({ path: resolve(__dirname, '../../dev/.env') })

export default async function globalTeardown() {
  try {
    const sql = getHostAdminDb()
    await cleanupTenancyTestData(sql)
    await cleanupCoreTestData(sql)
  } finally {
    await closeTestDatabases()
  }
}
