// Org admin disables an app from /settings/apps; tile vanishes from the
// launcher on the org home page.
import { test, expect } from '@playwright/test'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getHostAdminDb,
  closeTestDatabases,
  cleanupCoreTestData
} from '@nuxtinator/core/test-helpers'
import { cleanupTenancyTestData } from '@nuxtinator/tenancy/test-helpers'
import { loginIntoNewOrg } from './helpers/login'

const __dirname = dirname(fileURLToPath(import.meta.url))
loadDotenv({ path: resolve(__dirname, '../../dev/.env') })

const APP_TITLE_RE = /messages/i

test.afterAll(async () => {
  const sql = getHostAdminDb()
  await cleanupTenancyTestData(sql)
  await cleanupCoreTestData(sql)
  await closeTestDatabases()
})

test('disable an app from settings → tile disappears from the org launcher', async ({ page }) => {
  const { org } = await loginIntoNewOrg(page)

  // 1. Org home shows the Messages tile.
  await page.goto(`/@${org.slug}/dashboard`)
  await expect(page.locator('section').filter({ hasText: /apps/i }).first()).toContainText(APP_TITLE_RE)

  // 2. Disable Messages from settings/apps. The row uses USwitch (role=switch).
  await page.goto(`/@${org.slug}/settings/apps`)
  const messagesRow = page.locator('li').filter({ hasText: APP_TITLE_RE }).first()
  const toggle = messagesRow.getByRole('switch')
  // Wait for the disable POST to land before navigating — otherwise the
  // launcher fetch races the toggle write and intermittently still shows
  // Messages. This is the flake the messages-Playwright agent flagged.
  await Promise.all([
    page.waitForResponse(r => r.url().includes(`/api/o/${org.slug}/apps/messages/disable`) && r.status() === 200, { timeout: 10_000 }),
    toggle.click()
  ])

  // 3. Back to the launcher: Messages tile is gone.
  await page.goto(`/@${org.slug}/dashboard`)
  await expect(page.locator('section').filter({ hasText: /apps/i }).first()).not.toContainText(APP_TITLE_RE)
})

test('opening a disabled app\'s page redirects to the org home', async ({ page }) => {
  const { org } = await loginIntoNewOrg(page)

  await page.goto(`/@${org.slug}/messages`)
  await expect(page).toHaveURL(new RegExp(`/@${org.slug}/messages$`))

  await page.goto(`/@${org.slug}/settings/apps`)
  const toggle = page.locator('li').filter({ hasText: APP_TITLE_RE }).first().getByRole('switch')
  await Promise.all([
    page.waitForResponse(r => r.url().includes(`/api/o/${org.slug}/apps/messages/disable`) && r.status() === 200, { timeout: 10_000 }),
    toggle.click()
  ])

  await page.goto(`/@${org.slug}/messages`)
  await expect(page).toHaveURL(new RegExp(`/@${org.slug}/?$`), { timeout: 5000 })
})
