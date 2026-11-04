// E2E for the files layer. Marquee flows that don't touch real S3:
//   - create a document + edit/save (split editor)
//   - version history shows snapshots
//   - share link → anonymous public view renders → revoke → 404
//   - search finds a doc
//   - delete removes it from the list
//
// Binary upload (real B2) and file download/preview are covered by the vitest
// public-route test against a seeded fake storage_key; not driven here to keep
// the e2e run from uploading to the live bucket.
import { test, expect } from '@playwright/test'
import { loginIntoNewOrg } from './helpers/login'
import { getHostAdminDb } from '@nuxtinator/core/test-helpers'

const baseURL = process.env.TEST_BASE_URL || 'http://localhost:2090'

function idFromUrl(url: string): string {
  const m = url.match(/\/files\/([^/?#]+)/)
  return m?.[1] ?? ''
}

test.afterAll(async () => {
  // Drop files rows created by this run's test users.
  const sql = getHostAdminDb()
  await sql`
    DELETE FROM files_items
    WHERE created_by IN (SELECT id FROM users WHERE email LIKE 'test-%@example.com')
  `
})

test('create a document, edit and save it', async ({ page }) => {
  const { org } = await loginIntoNewOrg(page, { roles: ['admin'] })

  await page.goto(`/@${org.slug}/files`)
  await expect(page).toHaveURL(/\/files/)

  await page.getByRole('button', { name: /new document/i }).click()
  await page.getByPlaceholder('Document title').fill('Quarterly plan')
  await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/files/items') && r.request().method() === 'POST' && r.status() === 200),
    page.getByRole('button', { name: /^create$/i }).click()
  ])

  // Lands in the editor (split view). Type markdown and save.
  const textarea = page.locator('textarea')
  await expect(textarea).toBeVisible()
  await textarea.fill('# Heading\n\nSome **bold** body.')
  await Promise.all([
    page.waitForResponse(r => /\/api\/files\/items\/[^/]+$/.test(r.url()) && r.request().method() === 'PATCH' && r.status() === 200),
    page.getByRole('button', { name: /^save$/i }).click()
  ])

  // Rendered view shows the heading.
  await expect(page.locator('.markdown-body h1')).toHaveText('Heading')
})

test('version history lists snapshots', async ({ page }) => {
  const { org } = await loginIntoNewOrg(page, { roles: ['admin'] })
  await page.goto(`/@${org.slug}/files`)
  await page.getByRole('button', { name: /new document/i }).click()
  await page.getByPlaceholder('Document title').fill('Versioned doc')
  await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/files/items') && r.request().method() === 'POST' && r.status() === 200),
    page.getByRole('button', { name: /^create$/i }).click()
  ])
  const textarea = page.locator('textarea')
  await textarea.fill('first revision')
  await Promise.all([
    page.waitForResponse(r => /\/api\/files\/items\/[^/]+$/.test(r.url()) && r.request().method() === 'PATCH'),
    page.getByRole('button', { name: /^save$/i }).click()
  ])

  await Promise.all([
    page.waitForResponse(r => r.url().includes('/versions') && r.status() === 200),
    page.getByRole('button', { name: /versions/i }).click()
  ])
  // The slideover shows at least one "current" snapshot badge.
  await expect(page.getByText('current').first()).toBeVisible()
})

test('share link renders for an anonymous visitor, then 404s after revoke', async ({ page, browser }) => {
  const { org } = await loginIntoNewOrg(page, { roles: ['admin'] })
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto(`/@${org.slug}/files`)
  await page.getByRole('button', { name: /new document/i }).click()
  await page.getByPlaceholder('Document title').fill('Shared doc')
  await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/files/items') && r.request().method() === 'POST' && r.status() === 200),
    page.getByRole('button', { name: /^create$/i }).click()
  ])
  const textarea = page.locator('textarea')
  await expect(textarea).toBeVisible()
  const itemId = idFromUrl(page.url())
  await textarea.fill('visible to the public')
  await Promise.all([
    page.waitForResponse(r => /\/api\/files\/items\/[^/]+$/.test(r.url()) && r.request().method() === 'PATCH'),
    page.getByRole('button', { name: /^save$/i }).click()
  ])

  // Issue the share link — a single Share click should create *and* copy it.
  await Promise.all([
    page.waitForResponse(r => r.url().includes('/share') && r.request().method() === 'POST' && r.status() === 200),
    page.getByRole('button', { name: /^share$/i }).click()
  ])
  // onShare finished once the link controls appear; the URL should be on the clipboard.
  await expect(page.getByRole('button', { name: /copy link/i })).toBeVisible()
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  expect(clip).toContain('/files/public/')

  // Read the token straight from the DB and open it anonymously.
  const sql = getHostAdminDb()
  const rows = await sql`SELECT share_token FROM files_items WHERE id = ${itemId}`
  const token = rows[0]?.share_token as string
  expect(token).toBeTruthy()

  const anon = await browser.newContext()
  const anonPage = await anon.newPage()
  await anonPage.goto(`${baseURL}/files/public/${token}`)
  await expect(anonPage.locator('.markdown-body')).toContainText('visible to the public')

  // Revoke, then the anonymous view should 404 (Link unavailable empty state).
  await Promise.all([
    page.waitForResponse(r => r.url().includes('/share') && r.request().method() === 'DELETE' && r.status() === 200),
    page.getByRole('button', { name: /revoke/i }).click()
  ])
  await anonPage.goto(`${baseURL}/files/public/${token}`)
  await expect(anonPage.getByText(/link unavailable/i)).toBeVisible()
  await anon.close()
})

test('delete removes a document from the list', async ({ page }) => {
  const { org } = await loginIntoNewOrg(page, { roles: ['admin'] })
  await page.goto(`/@${org.slug}/files`)
  await page.getByRole('button', { name: /new document/i }).click()
  await page.getByPlaceholder('Document title').fill('Doomed doc')
  await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/files/items') && r.request().method() === 'POST' && r.status() === 200),
    page.getByRole('button', { name: /^create$/i }).click()
  ])

  // New docs open in the editor; Delete is in the header in both modes.
  await expect(page.locator('textarea')).toBeVisible()
  await page.getByRole('button', { name: /^delete$/i }).first().click()
  await Promise.all([
    page.waitForResponse(r => /\/api\/files\/items\/[^/]+$/.test(r.url()) && r.request().method() === 'DELETE' && r.status() === 200),
    page.getByRole('button', { name: /^delete$/i }).last().click()
  ])

  // Back on the list, the doc is gone.
  await expect(page).toHaveURL(/\/files$/)
  await expect(page.getByText('Doomed doc')).toHaveCount(0)
})
