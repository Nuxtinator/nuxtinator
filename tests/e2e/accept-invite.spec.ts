// Accept-invite flow as a new user. The invite is seeded directly into the DB
// (the invite-creation endpoint is covered by vitest); this test exercises the
// activation page → password set → auto-login → land in inviting org.
import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getHostAdminDb,
  closeTestDatabases,
  cleanupCoreTestData,
  createPendingInvite
} from '@nuxtinator/core/test-helpers'
import {
  createTestOrg,
  addTestMembership,
  cleanupTenancyTestData
} from '@nuxtinator/tenancy/test-helpers'

const __dirname = dirname(fileURLToPath(import.meta.url))
loadDotenv({ path: resolve(__dirname, '../../dev/.env') })

test.afterAll(async () => {
  const sql = getHostAdminDb()
  await cleanupTenancyTestData(sql)
  await cleanupCoreTestData(sql)
  await closeTestDatabases()
})

test('new-user invite: visit accept-invite link → set password → land in the inviting org', async ({ page, baseURL }) => {
  const sql = getHostAdminDb()
  const invite = await createPendingInvite(sql, { display_name: 'Invitee' })
  const org = await createTestOrg(sql, { name: 'Invite Co' })
  await addTestMembership(sql, { user_id: invite.userId, org_id: org.id, roles: ['member'] })

  const newPassword = `pw-${randomUUID().slice(0, 8)}`

  await page.goto(`/accept-invite?token=${invite.token}`)

  // The form pre-fills the email (read-only) — sanity check we landed on the right page.
  await expect(page.locator('input[type="email"]')).toHaveValue(invite.email)

  await page.fill('input[name="display_name"]', 'Invitee Final')
  await page.fill('input[name="password"]', newPassword)
  await page.fill('input[name="confirmPassword"]', newPassword)
  await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/auth/accept-invite') && r.status() === 200, { timeout: 10_000 }),
    page.getByRole('button', { name: /activate account/i }).click()
  ])

  // Single-org user → server returns redirect: `/@<slug>/dashboard`. The page now
  // honors it and navigates there directly.
  await expect(page).toHaveURL(new RegExp(`/@${org.slug}/dashboard$`), { timeout: 10_000 })
  await expect(page.locator('h1').first()).toContainText(org.name, { timeout: 5000 })

  const cookies = await page.context().cookies(baseURL!)
  expect(cookies.find(c => c.name === 'auth-token')?.value.length || 0).toBeGreaterThan(20)
})
