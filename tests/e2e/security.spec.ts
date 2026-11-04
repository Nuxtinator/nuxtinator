// Negative-path UI behavior — tests for bug classes vitest can't easily catch:
// router redirects, permission-gated UI, suspended-org rendering, slug renames.
import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getHostAdminDb,
  closeTestDatabases,
  cleanupCoreTestData
} from '@nuxtinator/core/test-helpers'
import {
  cleanupTenancyTestData,
  createTestOrg
} from '@nuxtinator/tenancy/test-helpers'
import { loginIntoNewOrg, loginAsNewUser } from './helpers/login'

const __dirname = dirname(fileURLToPath(import.meta.url))
loadDotenv({ path: resolve(__dirname, '../../dev/.env') })

test.afterAll(async () => {
  const sql = getHostAdminDb()
  await cleanupTenancyTestData(sql)
  await cleanupCoreTestData(sql)
  await closeTestDatabases()
})

test('unauthenticated visit to /admin/orgs redirects to /login with the original path preserved', async ({ page }) => {
  await page.goto('/admin/orgs')
  await expect(page).toHaveURL(/\/login\?redirect=/, { timeout: 5000 })
  // The redirect query param should encode the requested path.
  expect(page.url()).toMatch(/redirect=.*admin/)
})

test('member of orgA gets a 404 / error UI when visiting orgB they don\'t belong to', async ({ page }) => {
  const sql = getHostAdminDb()
  await loginIntoNewOrg(page) // user → orgA
  const orgB = await createTestOrg(sql) // user is NOT a member of orgB

  await page.goto(`/@${orgB.slug}/`)
  // The /api/o/<slug> endpoint returns 404 for non-members; the page renders
  // its error UAlert with the API's statusMessage.
  await expect(page.locator('body')).toContainText(/does not exist|don't have access/i, { timeout: 5000 })
})

test('suspended org renders the dedicated suspended-org page', async ({ page }) => {
  const sql = getHostAdminDb()
  const { org } = await loginIntoNewOrg(page)

  // Suspend the org directly via SQL (the suspend toggle endpoint is covered
  // by vitest; this test is about the UI behavior under the resulting 423).
  await sql`UPDATE orgs SET suspended_at = now() WHERE id = ${org.id}`

  await page.goto(`/@${org.slug}/`)
  await expect(page.locator('h1').first()).toContainText(/organization suspended/i, { timeout: 5000 })
  await expect(page.getByRole('link', { name: /back to organizations/i })).toBeVisible()
})

test('non-admin member does NOT see the Settings button on the org home page', async ({ page }) => {
  // User joins org as 'member' (not 'admin'), so org.settings.write is not in
  // their perms — the conditional Settings button shouldn't render.
  const { org } = await loginIntoNewOrg(page, { roles: ['member'] })

  await page.goto(`/@${org.slug}/`)
  // Sanity — page loaded the org details
  await expect(page.locator('h1').first()).toContainText(org.name)
  // Settings button is gated by org.settings.write
  await expect(page.getByRole('link', { name: /^settings$/i })).toHaveCount(0)
})

test('slug rename: old /@old-slug/ stops working, new /@new-slug/ works', async ({ page }) => {
  const sql = getHostAdminDb()
  const { org } = await loginIntoNewOrg(page)
  const newSlug = `test-tenancy-${randomUUID().slice(0, 8)}`

  // Rename via SQL (PATCH endpoint is covered by vitest).
  await sql`UPDATE orgs SET slug = ${newSlug} WHERE id = ${org.id}`

  // Old slug → API returns 404 (org doesn't exist) → page shows error.
  await page.goto(`/@${org.slug}/`)
  await expect(page.locator('body')).toContainText(/does not exist|don't have access/i, { timeout: 5000 })

  // New slug → loads cleanly with the org name.
  await page.goto(`/@${newSlug}/`)
  await expect(page.locator('h1').first()).toContainText(org.name, { timeout: 5000 })
})
