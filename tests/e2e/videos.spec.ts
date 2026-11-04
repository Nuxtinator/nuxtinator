// Videos app browser flows. Vitest already covers every API endpoint; these
// tests cover what vitest can't: clicks, list updates without reload,
// visibility-select changes, title editing, delete confirm, and the
// permission-gated view of public share pages.
//
// Pattern: seed videos directly via SQL (host_admin / BYPASSRLS) so each test
// only exercises the UI surface under test, not the upload path (which goes
// through S3 + the recorder pipeline — driven by getUserMedia, untestable
// in Playwright). Wrap every click that triggers an API call in
// `Promise.all([waitForResponse, click])` to avoid the canonical flake.
//
// SKIPPED FLOWS (with rationale):
//   - Recording a screen capture: uses navigator.mediaDevices.getDisplayMedia
//     + getUserMedia which Playwright can't drive reliably (no fake screens).
//   - File upload via the /videos/upload drop zone: the upload composable
//     compresses via mediabunny before sending; the synthetic file Playwright
//     would inject doesn't make it through that step in CI.
import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getHostAdminDb } from '@nuxtinator/core/test-helpers'
import { addTestMembership } from '@nuxtinator/tenancy/test-helpers'
import {
  cleanupVideosTestData,
  createVideosUser,
  createTestVideo
} from 'layer-videos/test-helpers'
import { loginIntoNewOrg } from './helpers/login'

const __dirname = dirname(fileURLToPath(import.meta.url))
loadDotenv({ path: resolve(__dirname, '../../dev/.env') })

// Per-spec cleanup. Global teardown handles closeTestDatabases().
test.afterAll(async () => {
  const sql = getHostAdminDb()
  await cleanupVideosTestData(sql)
})

test('library page shows the user\'s own videos under My videos and the title is editable inline', async ({ page }) => {
  const sql = getHostAdminDb()
  const { user, org } = await loginIntoNewOrg(page, { roles: ['admin'] })
  const video = await createTestVideo(sql, {
    org_id: org.id, user_id: user.id, title: 'original title', visibility: 'private'
  })

  await page.goto(`/@${org.slug}/videos`)
  await page.waitForResponse(r => r.url().includes('/api/videos') && r.url().includes('scope=mine') && r.status() === 200, { timeout: 10_000 })

  // The card with our seeded title is visible.
  const card = page.locator('.video-card').filter({ hasText: 'original title' })
  await expect(card).toBeVisible({ timeout: 5000 })

  // Click the pencil → input replaces the h3.
  await card.getByRole('button', { name: /edit title/i }).click()
  // After clicking edit, the h3 text disappears (replaced by input), so the
  // .filter({ hasText: 'original title' }) on `card` would resolve to 0
  // matches. Reach the input via the page-scoped locator instead.
  const input = page.locator('input.video-title-input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill('renamed via UI')
  await Promise.all([
    page.waitForResponse(r => r.url().includes(`/api/videos/${video.id}`) && r.request().method() === 'PATCH' && r.status() === 200),
    input.press('Enter')
  ])

  // The new title shows on the card without a reload.
  await expect(page.locator('.video-card').filter({ hasText: 'renamed via UI' })).toBeVisible({ timeout: 5000 })
})

test('switching to Team library tab shows only org-shared videos', async ({ page }) => {
  const sql = getHostAdminDb()
  const { user, org } = await loginIntoNewOrg(page, { roles: ['admin'] })
  // Caller seeds: one private + one org video.
  await createTestVideo(sql, { org_id: org.id, user_id: user.id, title: 'priv-mine', visibility: 'private' })
  await createTestVideo(sql, { org_id: org.id, user_id: user.id, title: 'team-shared', visibility: 'org' })

  await page.goto(`/@${org.slug}/videos`)
  await page.waitForResponse(r => r.url().includes('/api/videos') && r.status() === 200, { timeout: 10_000 })
  // My videos shows both.
  await expect(page.locator('.video-card').filter({ hasText: 'priv-mine' })).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.video-card').filter({ hasText: 'team-shared' })).toBeVisible({ timeout: 5000 })

  // Click the "Team library" tab → fetch with scope=team fires.
  await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/videos') && r.url().includes('scope=team') && r.status() === 200, { timeout: 10_000 }),
    page.getByRole('tab', { name: /team library/i }).click()
  ])

  // Only the org-shared video remains visible.
  await expect(page.locator('.video-card').filter({ hasText: 'team-shared' })).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.video-card').filter({ hasText: 'priv-mine' })).not.toBeVisible()
})

test('visibility select PATCHes the video and the UI reflects the new value', async ({ page }) => {
  const sql = getHostAdminDb()
  const { user, org } = await loginIntoNewOrg(page, { roles: ['admin'] })
  const video = await createTestVideo(sql, {
    org_id: org.id, user_id: user.id, title: 'change my visibility', visibility: 'private'
  })

  await page.goto(`/@${org.slug}/videos`)
  await page.waitForResponse(r => r.url().includes('/api/videos') && r.status() === 200, { timeout: 10_000 })

  const card = page.locator('.video-card').filter({ hasText: 'change my visibility' })
  await expect(card).toBeVisible({ timeout: 5000 })

  // The USelect renders the trigger as a button — open it, pick "Org".
  await card.locator('.video-visibility button').first().click()
  await Promise.all([
    page.waitForResponse(r => r.url().includes(`/api/videos/${video.id}`) && r.request().method() === 'PATCH' && r.status() === 200),
    page.getByRole('option', { name: /^org$/i }).click()
  ])

  // DB row was updated.
  const rows = await sql<{ visibility: string }[]>`SELECT visibility FROM videos WHERE id = ${video.id}`
  expect(rows[0]!.visibility).toBe('org')
})

test('delete confirm wipes the card from the grid without reload', async ({ page }) => {
  const sql = getHostAdminDb()
  const { user, org } = await loginIntoNewOrg(page, { roles: ['admin'] })
  const video = await createTestVideo(sql, {
    org_id: org.id, user_id: user.id, title: 'delete me'
  })

  await page.goto(`/@${org.slug}/videos`)
  await page.waitForResponse(r => r.url().includes('/api/videos') && r.status() === 200, { timeout: 10_000 })

  const card = page.locator('.video-card').filter({ hasText: 'delete me' })
  await expect(card).toBeVisible({ timeout: 5000 })

  // The library's deleteVideo() calls window.confirm() — auto-accept it.
  page.once('dialog', dialog => dialog.accept())

  // The trash button is a UButton with color=error variant=outline. Scope it
  // under our card; it's the only error-colored action.
  await Promise.all([
    page.waitForResponse(r => r.url().includes(`/api/videos/${video.id}`) && r.request().method() === 'DELETE' && r.status() === 200),
    card.locator('button').filter({ has: page.locator('span.iconify[class*="trash-2"], [class*="lucide-trash"], svg[class*="trash"]') }).first().click()
  ])

  await expect(card).not.toBeVisible({ timeout: 5000 })
})

test('watch page renders a public video for an anonymous visitor and tracks a view', async ({ page, baseURL }) => {
  const sql = getHostAdminDb()
  const { user, org } = await loginIntoNewOrg(page, { roles: ['admin'] })
  const video = await createTestVideo(sql, {
    org_id: org.id, user_id: user.id, title: 'public watch me', visibility: 'public', view_count: 0
  })

  // Anonymous: open a brand-new browser context so no auth cookie leaks in.
  const anonCtx = await page.context().browser()!.newContext()
  const anon = await anonCtx.newPage()

  // The watch page calls /api/videos/share/:token on mount; wait for the 200
  // and for the subsequent /view POST (within ~6s of the mount).
  await Promise.all([
    anon.waitForResponse(r => r.url().includes(`/api/videos/share/${video.share_token}`) && !r.url().includes('/view') && !r.url().includes('/play') && r.status() === 200, { timeout: 10_000 }),
    anon.goto(`${baseURL}/watch/${video.share_token}`)
  ])
  await anon.waitForResponse(r => r.url().includes(`/api/videos/share/${video.share_token}/view`) && r.status() === 200, { timeout: 10_000 })

  // Player + title render.
  await expect(anon.locator('h1.video-title')).toContainText('public watch me', { timeout: 5000 })
  await expect(anon.locator('video.video-player')).toBeVisible()

  // DB shows the view bumped to 1.
  const rows = await sql<{ view_count: number }[]>`SELECT view_count FROM videos WHERE id = ${video.id}`
  expect(rows[0]!.view_count).toBe(1)

  await anonCtx.close()
})

test('non-owner gets the private-video error UI when opening someone else\'s private share link', async ({ page, baseURL }) => {
  const sql = getHostAdminDb()
  const { user: owner, org } = await loginIntoNewOrg(page, { roles: ['admin'] })
  // Add a second user (not the share-link owner) in the same org.
  const other = await createVideosUser(sql)
  await addTestMembership(sql, { user_id: other.id, org_id: org.id, roles: ['member'] })

  const video = await createTestVideo(sql, {
    org_id: org.id, user_id: owner.id, title: 'private watch attempt', visibility: 'private'
  })

  // Use the existing page session (signed in as `owner` from loginIntoNewOrg
  // — switch to `other`'s session via a fresh context).
  const otherCtx = await page.context().browser()!.newContext()
  const otherPage = await otherCtx.newPage()
  const { generateTestToken } = await import('@nuxtinator/core/test-helpers')
  await otherCtx.addCookies([{
    name: 'auth-token',
    value: generateTestToken(other),
    url: baseURL || 'http://localhost:2090',
    httpOnly: true,
    sameSite: 'Lax'
  }])

  await otherPage.goto(`${baseURL}/watch/${video.share_token}`)
  // The page swallows the 403 and shows an "Error Loading Video" card with
  // the server-provided message.
  await expect(otherPage.locator('.error-card h2')).toContainText(/error/i, { timeout: 5000 })
  await expect(otherPage.locator('video.video-player')).not.toBeVisible()

  await otherCtx.close()
})

test('library Upload + New Recording buttons route to the correct pages', async ({ page }) => {
  const { org } = await loginIntoNewOrg(page, { roles: ['admin'] })

  await page.goto(`/@${org.slug}/videos`)
  await page.waitForResponse(r => r.url().includes('/api/videos') && r.status() === 200, { timeout: 10_000 })

  // The header's "Upload" button (UButton with `to="/videos/upload"`) renders
  // as an anchor; clicking nav-pushes to the tenancy-aliased path.
  await page.getByRole('link', { name: /^upload$/i }).click()
  await expect(page).toHaveURL(new RegExp(`/@${org.slug}/videos/upload`), { timeout: 5000 })
  // The PageHeader on the upload page shows our heading.
  await expect(page.locator('h1, h2').filter({ hasText: /upload video/i }).first()).toBeVisible({ timeout: 5000 })

  // Back to library, then Recording.
  await page.goto(`/@${org.slug}/videos`)
  await page.getByRole('link', { name: /new recording/i }).click()
  await expect(page).toHaveURL(new RegExp(`/@${org.slug}/videos/record`), { timeout: 5000 })
})

test('empty state shows the right CTA when no videos exist for the user', async ({ page }) => {
  const { org } = await loginIntoNewOrg(page, { roles: ['admin'] })

  await page.goto(`/@${org.slug}/videos`)
  await page.waitForResponse(r => r.url().includes('/api/videos') && r.status() === 200, { timeout: 10_000 })

  // index.vue's empty-state for scope='mine'.
  await expect(page.locator('.empty-state h2')).toContainText(/no recordings yet/i, { timeout: 5000 })
  // CTA: "Start Recording" UButton.
  await expect(page.getByRole('link', { name: /start recording/i })).toBeVisible()
})
