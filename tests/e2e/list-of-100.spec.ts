// List of 100 app browser flows. Vitest already covers every API endpoint;
// these tests cover what vitest can't: clicks, form submits, list updates
// without reload, modal interactions, navigation between tabs, and the chart
// view rendering.
//
// Pattern: seed users/orgs directly via SQL (host_admin / BYPASSRLS) so each
// test exercises the UI surface, not setup. Wrap every click that triggers an
// API call in `Promise.all([waitForResponse, click])` — asserting on the URL
// or DOM before the API responds is the canonical flake source in this repo.
//
// Skipped UI behaviors (with reasoning):
// - Drag-and-drop on the Kanban (HTML5 native DnD). Playwright's
//   `dragTo`/`mouse.down/move/up` flow is unreliable against native DnD on
//   WebKit; the API endpoint behind it (PATCH faith_status) is already
//   covered by vitest.
// - Apexcharts internals (bar/line series, tooltips). The chart embeds an
//   svg/canvas hierarchy that's not stable for selector assertions. We only
//   assert the chart container renders without errors and the summary
//   counters reflect seeded data.
import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getHostAdminDb,
  cleanupCoreTestData
} from '@nuxtinator/core/test-helpers'
import { cleanupTenancyTestData } from '@nuxtinator/tenancy/test-helpers'
import {
  cleanupListOf100TestData,
  createTestContact
} from 'layer-list-of-100/test-helpers'
import { loginIntoNewOrg } from './helpers/login'

const __dirname = dirname(fileURLToPath(import.meta.url))
loadDotenv({ path: resolve(__dirname, '../../dev/.env') })

// Per-spec cleanup. Global teardown handles closeTestDatabases().
test.afterAll(async () => {
  const sql = getHostAdminDb()
  await cleanupListOf100TestData(sql)
  await cleanupTenancyTestData(sql)
  await cleanupCoreTestData(sql)
})

test('add a contact via the modal; appears in the list with progress incremented', async ({ page }) => {
  const { org } = await loginIntoNewOrg(page, { roles: ['admin'] })
  await page.goto(`/@${org.slug}/list-of-100`)

  await expect(page.getByRole('heading', { name: /list of 100/i })).toBeVisible({ timeout: 5000 })
  // Empty-state copy.
  await expect(page.locator('body')).toContainText(/your list is empty/i, { timeout: 5000 })

  await page.getByRole('button', { name: /add contact/i }).first().click()

  const name = `test-list-of-100-${randomUUID().slice(0, 6)}`
  await page.fill('input[placeholder="Their name"]', name)
  // The textarea is the "Notes" field — placeholder reads "Anything to remember…".
  await page.fill('textarea[placeholder="Anything to remember…"]', 'A test contact')

  await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/list-of-100/contacts') && r.request().method() === 'POST' && r.status() === 200),
    page.getByRole('button', { name: /^add contact$/i }).last().click()
  ])

  // Table row with the new contact appears without a page reload.
  await expect(page.locator('table').filter({ hasText: name })).toBeVisible({ timeout: 5000 })
  // Progress header bumps to 1 (rendered as "1/ 100" in ProgressHeader.vue).
  await expect(page.locator('body')).toContainText(/1\s*\/\s*100/i, { timeout: 5000 })
})

test('mark-contacted from the table updates the "Contacted" column from "never" to "just now"', async ({ page }) => {
  const sql = getHostAdminDb()
  const { user, org } = await loginIntoNewOrg(page, { roles: ['admin'] })
  await createTestContact(sql, { user_id: user.id, org_id: org.id, name: 'Mark Me' })

  await page.goto(`/@${org.slug}/list-of-100`)
  // Row exists, contacted column reads "never" before we tap.
  const row = page.locator('tr').filter({ hasText: 'Mark Me' }).first()
  await expect(row).toBeVisible({ timeout: 5000 })
  await expect(row).toContainText(/never/i)

  // Click the contacted button (UButton with the relative-time label).
  await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/list-of-100/contacts/') && r.url().includes('/mark-contacted') && r.status() === 200),
    row.getByRole('button').filter({ hasText: /never/i }).first().click()
  ])

  // After the API resolves the cell reads "just now" (or "0m ago").
  await expect(row).toContainText(/just now|0m ago/i, { timeout: 5000 })
})

test('edit a contact via the row → modal opens with prefilled values → patch persists', async ({ page }) => {
  const sql = getHostAdminDb()
  const { user, org } = await loginIntoNewOrg(page, { roles: ['admin'] })
  const c = await createTestContact(sql, {
    user_id: user.id, org_id: org.id, name: 'Old Name', notes: null, faith_status: 'unknown'
  })

  await page.goto(`/@${org.slug}/list-of-100`)
  // Click the name cell to open the edit modal.
  await page.getByRole('button', { name: 'Old Name' }).first().click()

  // Modal title is the contact name. The form's Name input is prefilled.
  const nameInput = page.locator('input[placeholder="Their name"]')
  await expect(nameInput).toHaveValue('Old Name', { timeout: 5000 })

  await nameInput.fill('New Name')
  await Promise.all([
    page.waitForResponse(r => r.url().includes(`/api/list-of-100/contacts/${c.id}`) && r.request().method() === 'PATCH' && r.status() === 200),
    page.getByRole('button', { name: /^save$/i }).click()
  ])

  // Table reflects the new name without a reload.
  await expect(page.locator('table').filter({ hasText: 'New Name' })).toBeVisible({ timeout: 5000 })
  await expect(page.locator('table')).not.toContainText('Old Name')

  // DB has the renamed row.
  const rows = await sql<{ name: string }[]>`SELECT name FROM list_of_100_contacts WHERE id = ${c.id}`
  expect(rows[0]!.name).toBe('New Name')
})

test('delete a contact via the row actions menu; row disappears from the table', async ({ page }) => {
  const sql = getHostAdminDb()
  const { user, org } = await loginIntoNewOrg(page, { roles: ['admin'] })
  const c = await createTestContact(sql, { user_id: user.id, org_id: org.id, name: 'Delete Me' })

  await page.goto(`/@${org.slug}/list-of-100`)

  const row = page.locator('tr').filter({ hasText: 'Delete Me' }).first()
  await expect(row).toBeVisible({ timeout: 5000 })

  // The `confirm()` dialog in deleteContact() — auto-accept it.
  page.once('dialog', d => d.accept())

  await row.getByRole('button', { name: /more actions/i }).first().click()
  await Promise.all([
    page.waitForResponse(r => r.url().includes(`/api/list-of-100/contacts/${c.id}`) && r.request().method() === 'DELETE' && r.status() === 200),
    page.getByRole('menuitem', { name: /^delete$/i }).click()
  ])

  // Row gone, empty-state returns.
  await expect(page.locator('body')).toContainText(/your list is empty/i, { timeout: 5000 })
  const rows = await sql<{ id: string }[]>`SELECT id FROM list_of_100_contacts WHERE id = ${c.id}`
  expect(rows.length).toBe(0)
})

test('list view with several contacts populated; all names render in the table', async ({ page }) => {
  const sql = getHostAdminDb()
  const { user, org } = await loginIntoNewOrg(page, { roles: ['admin'] })
  const names = ['Alpha Test', 'Beta Test', 'Gamma Test', 'Delta Test']
  for (const name of names) {
    await createTestContact(sql, { user_id: user.id, org_id: org.id, name })
  }

  await page.goto(`/@${org.slug}/list-of-100`)
  // Progress reads N/100 (ProgressHeader.vue renders as "4/ 100").
  await expect(page.locator('body')).toContainText(/4\s*\/\s*100/i, { timeout: 5000 })

  // All names visible in the table.
  for (const name of names) {
    await expect(page.locator('table').filter({ hasText: name })).toBeVisible({ timeout: 5000 })
  }
})

test('search filters the visible rows by name', async ({ page }) => {
  const sql = getHostAdminDb()
  const { user, org } = await loginIntoNewOrg(page, { roles: ['admin'] })
  await createTestContact(sql, { user_id: user.id, org_id: org.id, name: 'Aaron Apple' })
  await createTestContact(sql, { user_id: user.id, org_id: org.id, name: 'Beth Banana' })
  await createTestContact(sql, { user_id: user.id, org_id: org.id, name: 'Chris Cherry' })

  await page.goto(`/@${org.slug}/list-of-100`)
  await expect(page.locator('table').filter({ hasText: 'Aaron Apple' })).toBeVisible({ timeout: 5000 })

  await page.fill('input[placeholder="Search contacts…"]', 'Banana')

  await expect(page.locator('table').filter({ hasText: 'Beth Banana' })).toBeVisible({ timeout: 5000 })
  await expect(page.locator('table')).not.toContainText('Aaron Apple')
  await expect(page.locator('table')).not.toContainText('Chris Cherry')
})

test('insights tab renders the chart container without throwing; totals reflect seeded rhythm', async ({ page }) => {
  const sql = getHostAdminDb()
  const { user, org } = await loginIntoNewOrg(page, { roles: ['admin'] })
  const c = await createTestContact(sql, { user_id: user.id, org_id: org.id, name: 'Charted' })
  // Two MARK_CONTACTED today + one MARK_PRAYED.
  for (let i = 0; i < 2; i++) {
    await sql`
      INSERT INTO activity_logs (id, timestamp, event_type, table_name, record_id, user_id, metadata)
      VALUES (gen_random_uuid(), now(), 'MARK_CONTACTED', 'list_of_100_contacts', ${c.id}, ${user.id}, '{}'::jsonb)
    `
  }
  await sql`
    INSERT INTO activity_logs (id, timestamp, event_type, table_name, record_id, user_id, metadata)
    VALUES (gen_random_uuid(), now(), 'MARK_PRAYED', 'list_of_100_contacts', ${c.id}, ${user.id}, '{}'::jsonb)
  `

  await page.goto(`/@${org.slug}/list-of-100`)

  // Switch to the Insights tab. waitForResponse on the insights GET ensures the
  // chart's mount completes before we assert.
  await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/list-of-100/insights') && r.status() === 200),
    page.getByRole('tab', { name: /insights/i }).click()
  ])

  // Daily-rhythm heading is the tab content's title.
  await expect(page.getByRole('heading', { name: /daily rhythm/i })).toBeVisible({ timeout: 5000 })

  // The three summary tiles show the right totals. Match the tile (a
  // .rounded-lg .border container) whose label text is exactly "Contacts" or
  // "Prayers" — `hasText` regex anchoring isn't reliable on nested
  // grandparents, so scope to the explicit tile shape.
  const contactsTile = page.locator('.rounded-lg.border').filter({ hasText: /^\s*Contacts\s*\d/i }).first()
  await expect(contactsTile).toContainText('2', { timeout: 5000 })
  const prayersTile = page.locator('.rounded-lg.border').filter({ hasText: /^\s*Prayers\s*\d/i }).first()
  await expect(prayersTile).toContainText('1', { timeout: 5000 })

  // Chart container renders; apexcharts injects an SVG inside the .insights-chart wrapper.
  await expect(page.locator('.insights-chart svg').first()).toBeVisible({ timeout: 10_000 })
})

test('view tabs switch between table / kanban / relationships / insights via the URL', async ({ page }) => {
  const sql = getHostAdminDb()
  const { user, org } = await loginIntoNewOrg(page, { roles: ['admin'] })
  await createTestContact(sql, { user_id: user.id, org_id: org.id, name: 'View Switch', faith_status: 'believer' })

  await page.goto(`/@${org.slug}/list-of-100`)
  // Default is the table view.
  await expect(page.locator('table').filter({ hasText: 'View Switch' })).toBeVisible({ timeout: 5000 })

  // Status view (kanban).
  await page.getByRole('tab', { name: /status/i }).click()
  await expect(page).toHaveURL(/view=kanban/, { timeout: 5000 })
  // Believer column has the contact card.
  const believerColumn = page.locator('div').filter({ hasText: /^Believer\s*1$/i }).first()
  await expect(believerColumn).toBeVisible({ timeout: 5000 })

  // Relationship view.
  await page.getByRole('tab', { name: /relationship/i }).click()
  await expect(page).toHaveURL(/view=relationships/, { timeout: 5000 })

  // Back to List.
  await page.getByRole('tab', { name: /^list$/i }).click()
  await expect(page).toHaveURL(/\/list-of-100(\?|$)/, { timeout: 5000 })
})
