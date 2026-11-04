// Forgot password → email link → reset → log in with new password.
// Exercises the password-reset flow end-to-end through the browser.
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
  extractTokenFromBody,
  clearMailhog
} from '@nuxtinator/core/test-helpers'

const __dirname = dirname(fileURLToPath(import.meta.url))
loadDotenv({ path: resolve(__dirname, '../../dev/.env') })

test.beforeEach(async () => {
  await clearMailhog()
})

test.afterAll(async () => {
  const sql = getHostAdminDb()
  await cleanupCoreTestData(sql)
  await closeTestDatabases()
})

test('forgot password → email reset link → set new password → log in with it', async ({ page }) => {
  const sql = getHostAdminDb()
  const oldPassword = `old-${randomUUID().slice(0, 6)}`
  const newPassword = `new-${randomUUID().slice(0, 6)}`
  const user = await createTestUser(sql, { password: oldPassword })

  // 1. From login page, click "Forgot Password?" — opens the inline reset form
  await page.goto('/login')
  await page.getByRole('button', { name: /forgot password/i }).click()

  // 2. Submit forgot-password with the user's email
  await page.fill('input[type="email"]', user.email)
  await page.getByRole('button', { name: /send|reset link/i }).first().click()

  // 3. Pull the reset token out of Mailpit and visit the reset URL
  const msg = await waitForMailTo(user.email)
  const token = extractTokenFromBody(msg.body, 'token')
  await page.goto(`/reset-password?token=${token}`)

  // 4. Submit the new password. Wait for the API to complete (the page only
  //    shows the success card after the await resolves), then for the
  //    setTimeout-driven redirect to /login.
  await page.fill('input[name="password"]', newPassword)
  await page.fill('input[name="confirmPassword"]', newPassword)
  await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/auth/reset-password') && r.status() === 200, { timeout: 10_000 }),
    page.getByRole('button', { name: /reset password|submit/i }).first().click()
  ])

  // 5. Should land on /login (reset-password.vue does a 2-second setTimeout).
  await expect(page).toHaveURL(/\/login/, { timeout: 10_000 })

  // 6. The new password lets the user log in. Wait for the login API
  //    response so we don't race the URL change.
  await page.fill('input[name="email"]', user.email)
  await page.fill('input[name="password"]', newPassword)
  await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/auth/login') && r.status() === 200, { timeout: 10_000 }),
    page.click('button[type="submit"]')
  ])
  await expect(page).not.toHaveURL(/\/login/, { timeout: 10_000 })
})
