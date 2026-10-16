// Org admin invites a member from the settings/members page. Exercises the
// modal form, the API round-trip, the email capture in Mailpit, and the
// invitee accepting the link.
import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getHostAdminDb,
  closeTestDatabases,
  cleanupCoreTestData,
  waitForMailTo,
  extractTokenFromBody,
  clearMailhog
} from '@nuxtinator/core/test-helpers'
import { cleanupTenancyTestData } from '@nuxtinator/tenancy/test-helpers'
import { loginIntoNewOrg } from './helpers/login'

const __dirname = dirname(fileURLToPath(import.meta.url))
loadDotenv({ path: resolve(__dirname, '../../dev/.env') })

test.beforeEach(async () => {
  await clearMailhog()
})

test.afterAll(async () => {
  const sql = getHostAdminDb()
  await cleanupTenancyTestData(sql)
  await cleanupCoreTestData(sql)
  await closeTestDatabases()
})

test('org admin invites a new email; invite email arrives; new user can accept', async ({ page, baseURL }) => {
  const { org } = await loginIntoNewOrg(page)
  const inviteeEmail = `test-tenancy-orginvite-${randomUUID().slice(0, 8)}@example.com`

  // 1. Open settings/members → click "Invite member"
  await page.goto(`/@${org.slug}/settings/members`)
  await page.getByRole('button', { name: /invite member/i }).click()

  // 2. Fill the modal and submit
  await page.fill('input[type="email"]', inviteeEmail)
  await page.fill('input[placeholder="Their name"]', 'Invited Person')
  await page.getByRole('button', { name: /send invite/i }).click()

  // 3. Toast confirms the invite was sent (modal closes, toast appears).
  await expect(page.locator('body')).toContainText(/invite sent/i, { timeout: 5000 })

  // 4. Mailpit captured the invite email; the link contains a valid token.
  const msg = await waitForMailTo(inviteeEmail)
  const token = extractTokenFromBody(msg.body, 'token')

  // 5. Invitee opens a clean browser context, accepts the invite, and lands
  //    directly in the inviting org (single-org redirect from the API).
  const inviteeContext = await page.context().browser()!.newContext()
  const inviteePage = await inviteeContext.newPage()
  await inviteePage.goto(`${baseURL}/accept-invite?token=${token}`)
  const newPassword = `pw-${randomUUID().slice(0, 8)}`
  await inviteePage.fill('input[name="display_name"]', 'Invited Person Final')
  await inviteePage.fill('input[name="password"]', newPassword)
  await inviteePage.fill('input[name="confirmPassword"]', newPassword)
  await Promise.all([
    inviteePage.waitForResponse(r => r.url().includes('/api/auth/accept-invite') && r.status() === 200, { timeout: 10_000 }),
    inviteePage.getByRole('button', { name: /activate account/i }).click()
  ])
  await expect(inviteePage).toHaveURL(new RegExp(`/@${org.slug}/dashboard$`), { timeout: 10_000 })
  await expect(inviteePage.locator('h1').first()).toContainText(org.name, { timeout: 5000 })
  await inviteeContext.close()
})
