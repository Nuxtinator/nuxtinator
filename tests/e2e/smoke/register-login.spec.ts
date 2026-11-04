// The one UI-driven login test. Goes through register → email verification
// → login → lands logged in. Every other browser test should use the
// loginAsNewUser helper (cookie injection) instead.
import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getHostAdminDb,
  closeTestDatabases,
  cleanupCoreTestData,
  createTestUser,
  waitForMailTo,
  extractTokenFromBody
} from '@nuxtinator/core/test-helpers'

const __dirname = dirname(fileURLToPath(import.meta.url))
loadDotenv({ path: resolve(__dirname, '../../../dev/.env') })

test.afterAll(async () => {
  const sql = getHostAdminDb()
  await cleanupCoreTestData(sql)
  await closeTestDatabases()
})

test('register → verify → login → land authenticated', async ({ page, baseURL }) => {
  // Pre-seed a user so the new registration is NOT first-user (first-user
  // is auto-verified + auto-logged-in, which skips the verify + login UI we
  // want to exercise here).
  const sql = getHostAdminDb()
  await createTestUser(sql, { email: `test-core-smoke-seed-${randomUUID().slice(0, 8)}@example.com` })

  const email = `test-core-smoke-${randomUUID().slice(0, 8)}@example.com`
  const password = 'testpassword123'
  const display_name = 'Smoke User'

  // --- Register ---
  await page.goto('/register')
  await page.fill('input[name="display_name"]', display_name)
  await page.fill('input[name="email"]', email)
  await page.fill('input[name="password"]', password)
  await page.fill('input[name="confirmPassword"]', password)
  await page.click('button[type="submit"]')

  // The register handler returns a JSON response with a "check your email"
  // message in normal-flow registration. The page UI should reflect that.
  await expect(page.locator('body')).toContainText(/verify|check your email|check the email/i, { timeout: 5000 })

  // --- Pull verification token out of Mailpit and visit the link ---
  const msg = await waitForMailTo(email)
  const token = extractTokenFromBody(msg.body, 'token')
  await page.goto(`/api/auth/verify?token=${token}`)

  // --- Login ---
  await page.goto('/login')
  await page.fill('input[name="email"]', email)
  await page.fill('input[name="password"]', password)
  await page.click('button[type="submit"]')

  // After login the user has no orgs → lands on /orgs (the org picker).
  await expect(page).not.toHaveURL(/\/login/, { timeout: 10000 })

  const cookies = await page.context().cookies(baseURL!)
  const authCookie = cookies.find(c => c.name === 'auth-token')
  expect(authCookie).toBeDefined()
  expect(authCookie!.value.length).toBeGreaterThan(20)
})
