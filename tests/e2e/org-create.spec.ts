// Host admin creates a new org from /orgs/new.
// (The current UI puts the create form there for both first-time and operator-
//  admin flows; /admin/orgs is the host-admin org list, but actual creation
//  goes through /orgs/new for the operator-admin path too.)
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
import { cleanupTenancyTestData } from '@nuxtinator/tenancy/test-helpers'
import { loginAsNewUser } from './helpers/login'

const __dirname = dirname(fileURLToPath(import.meta.url))
loadDotenv({ path: resolve(__dirname, '../../dev/.env') })

test.afterAll(async () => {
  const sql = getHostAdminDb()
  await cleanupTenancyTestData(sql)
  await cleanupCoreTestData(sql)
  await closeTestDatabases()
})

test('operator admin creates a new org and lands inside it', async ({ page }) => {
  await loginAsNewUser(page, { is_admin: true })

  const slug = `test-tenancy-${randomUUID().slice(0, 8)}`
  const name = `Created Org ${slug}`

  await page.goto('/orgs/new')
  await page.fill('input[placeholder="Acme Inc."]', name)
  await page.fill('input[placeholder="acme"]', slug)
  await page.getByRole('button', { name: /^create$/i }).click()

  // Lands at /@<slug>/dashboard with the org name visible in the chrome / page.
  await expect(page).toHaveURL(new RegExp(`/@${slug}/dashboard$`), { timeout: 5000 })
  await expect(page.locator('body')).toContainText(name)

  // The org row exists in the DB with the user as admin.
  const sql = getHostAdminDb()
  const rows = await sql<{ id: string }[]>`SELECT id FROM orgs WHERE slug = ${slug}`
  expect(rows.length).toBe(1)
  const memberships = await sql<{ roles: string[] }[]>`SELECT roles FROM memberships WHERE org_id = ${rows[0]!.id}`
  expect(memberships[0]!.roles).toEqual(['admin'])
})
