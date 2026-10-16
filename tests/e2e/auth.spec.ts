// Login UI + logout. The smoke test in smoke/register-login.spec.ts already
// covers register; this file covers login-as-existing-user (single-org auto-
// redirect into the org) and logout (cookie clears, redirected back to /login).
import { test, expect } from '@playwright/test'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getHostAdminDb,
  closeTestDatabases,
  cleanupCoreTestData,
  createTestUser
} from '@nuxtinator/core/test-helpers'
import {
  createTestOrg,
  addTestMembership,
  cleanupTenancyTestData
} from '@nuxtinator/tenancy/test-helpers'
import { loginAsNewUser } from './helpers/login'

const __dirname = dirname(fileURLToPath(import.meta.url))
loadDotenv({ path: resolve(__dirname, '../../dev/.env') })

test.afterAll(async () => {
  const sql = getHostAdminDb()
  await cleanupTenancyTestData(sql)
  await cleanupCoreTestData(sql)
  await closeTestDatabases()
})

test('login form auto-redirects single-org user past the picker into their org', async ({ page }) => {
  const sql = getHostAdminDb()
  const user = await createTestUser(sql, { password: 'testpassword123' })
  const org = await createTestOrg(sql)
  await addTestMembership(sql, { user_id: user.id, org_id: org.id, roles: ['admin'] })

  await page.goto('/login')
  await page.fill('input[name="email"]', user.email)
  await page.fill('input[name="password"]', 'testpassword123')
  await page.click('button[type="submit"]')

  await expect(page).toHaveURL(new RegExp(`/@${org.slug}/dashboard$`), { timeout: 5000 })
  await expect(page.locator('body')).toContainText(org.name)
})

test('logout clears the auth cookie and returns the user to /login', async ({ page, baseURL }) => {
  await loginAsNewUser(page)

  await page.goto('/account')
  await page.getByRole('button', { name: /sign out/i }).click()

  await expect(page).toHaveURL(/\/login/, { timeout: 5000 })

  const cookies = await page.context().cookies(baseURL!)
  const auth = cookies.find(c => c.name === 'auth-token')
  // Cookie either deleted or zeroed out.
  expect(auth?.value || '').toBe('')
})
