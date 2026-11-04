// Org switcher: a multi-org user lands on the org picker, picks one, then uses
// the OrgSwitcher dropdown in the chrome to jump to a different org.
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
import { loginIntoMultipleOrgs } from './helpers/login'

const __dirname = dirname(fileURLToPath(import.meta.url))
loadDotenv({ path: resolve(__dirname, '../../dev/.env') })

test.afterAll(async () => {
  const sql = getHostAdminDb()
  await cleanupTenancyTestData(sql)
  await cleanupCoreTestData(sql)
  await closeTestDatabases()
})

test('multi-org user: picker shows all orgs; dropdown switches to another', async ({ page }) => {
  const { orgs } = await loginIntoMultipleOrgs(page, 2)
  const [a, b] = orgs

  // /orgs picker lists both
  await page.goto('/orgs')
  await expect(page.locator('body')).toContainText(a!.name)
  await expect(page.locator('body')).toContainText(b!.name)

  // Click into orgA
  await page.locator(`a[href="/@${a!.slug}/dashboard"]`).first().click()
  await expect(page).toHaveURL(new RegExp(`/@${a!.slug}/dashboard$`), { timeout: 5000 })

  // Open OrgSwitcher dropdown (the trigger has aria-label "Active organization: ...")
  await page.getByRole('button', { name: new RegExp(`Active organization: ${a!.name}`, 'i') }).click()

  // Click the other org in the popover
  await page.locator(`a[href="/@${b!.slug}/dashboard"]`).first().click()
  await expect(page).toHaveURL(new RegExp(`/@${b!.slug}/dashboard$`), { timeout: 5000 })
  await expect(page.locator('body')).toContainText(b!.name)
})

test('switching from an app into an org that has it disabled lands on that org\'s home', async ({ page }) => {
  const { orgs } = await loginIntoMultipleOrgs(page, 2)
  const [a, b] = orgs
  const sql = getHostAdminDb()
  await sql`
    INSERT INTO org_apps (org_id, app_id, enabled, source)
    VALUES (${b!.id}, 'messages', false, 'org_admin')
    ON CONFLICT (org_id, app_id) DO UPDATE SET enabled = false, source = 'org_admin'
  `

  await page.goto(`/@${a!.slug}/messages`)
  await expect(page).toHaveURL(new RegExp(`/@${a!.slug}/messages$`))

  await page.getByRole('button', { name: new RegExp(`Active organization: ${a!.name}`, 'i') }).click()
  await page.locator(`a[href="/@${b!.slug}/messages"]`).first().click()
  await expect(page).toHaveURL(new RegExp(`/@${b!.slug}/dashboard$`), { timeout: 5000 })
})
