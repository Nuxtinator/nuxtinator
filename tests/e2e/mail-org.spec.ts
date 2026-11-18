// An org admin's email settings (/@<slug>/settings/email): proving ownership
// of a domain, its DNS records, the "send our mail from" switch, the stream
// picker, and an org-owned provider account.
// Needs a server started with MAIL_FAKE_PROVIDER=1 and MAIL_TRANSPORT=provider.
import { test, expect, type Browser } from '@playwright/test'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestDatabases, cleanupCoreTestData, getHostAdminDb } from '@nuxtinator/core/test-helpers'
import { cleanupTenancyTestData } from '@nuxtinator/tenancy/test-helpers'
import { loginAsNewUser, loginIntoNewOrg } from './helpers/login'
import { E2E_MAIL_LABEL, cleanupMailTestData, deliverInbound, e2eDomain, fakeAvailable, fakeControl, pickOption } from './helpers/mail'

const __dirname = dirname(fileURLToPath(import.meta.url))
loadDotenv({ path: resolve(__dirname, '../../dev/.env') })

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  test.skip(!await fakeAvailable(page.request), 'needs MAIL_FAKE_PROVIDER=1 on the server')
  await fakeControl(page.request, { reset: true, deliver: false, domainStatus: 'verified' })
})

test.afterAll(async () => {
  await cleanupMailTestData()
  const sql = getHostAdminDb()
  await cleanupTenancyTestData(sql)
  await cleanupCoreTestData(sql)
  await closeTestDatabases()
})

// Points organizations' domains at a fake host account, as a host admin.
async function useFakeHostAccountForOrgs(browser: Browser): Promise<{ id: string, webhookUrls: { inboundMime: string } }> {
  const context = await browser.newContext()
  const page = await context.newPage()
  await loginAsNewUser(page, { is_admin: true })
  const res = await page.request.post('/api/admin/mail/accounts', {
    data: { provider: 'fake', label: `${E2E_MAIL_LABEL}-host-for-orgs`, credentials: { apiKey: 'e2e-api-key', signingKey: 'e2e-signing-key' } }
  })
  expect(res.ok()).toBeTruthy()
  const { account } = await res.json() as { account: { id: string, webhookUrls: { inboundMime: string } } }
  const put = await page.request.put('/api/admin/mail/org-accounts', { data: { sendAccountId: account.id, receiveAccountId: account.id } })
  expect(put.ok()).toBeTruthy()
  await context.close()
  return account
}

test('own domain: ownership record, DNS records, the switch, and the stream picker', async ({ page, browser }) => {
  await useFakeHostAccountForOrgs(browser)
  const { org } = await loginIntoNewOrg(page)
  const domain = e2eDomain('o')

  await page.goto(`/@${org.slug}/settings/email`)
  await page.getByRole('button', { name: 'Use our own domain' }).click()
  const modal = page.getByRole('dialog')
  await modal.getByRole('textbox', { name: /^Domain/ }).fill(domain)
  await modal.getByRole('switch', { name: /Receive email on this domain/ }).click()
  await modal.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(page.getByText(`${domain} added`, { exact: true })).toBeVisible()

  // Ownership comes first: one TXT record, nothing else yet.
  await expect(page.getByText(`_nx-verify.${domain}`)).toBeVisible()
  await expect(page.getByText('Waiting for the record. DNS changes can take a few hours.')).toBeVisible()
  await expect(page.getByRole('switch')).toHaveCount(0)

  const domains = await (await page.request.get(`/api/o/${org.slug}/mail/domains`)).json() as { domains: { ownershipRecord: { name: string, value: string } }[] }
  const record = domains.domains[0]!.ownershipRecord
  await fakeControl(page.request, { dns: [{ name: record.name, txt: [record.value] }] })

  await page.getByRole('button', { name: 'Check now' }).click()
  await expect(page.getByText('Ownership confirmed', { exact: true })).toBeVisible()
  await expect(page.getByText('v=spf1 include:fake.example ~all')).toBeVisible()

  const toggle = page.getByRole('switch', { name: `Send our mail from ${domain}` })
  await expect(toggle).toBeDisabled()
  await page.getByRole('button', { name: 'Check now' }).click()
  await expect(toggle).toBeEnabled()
  await toggle.click()
  await expect(page.getByText(`Mail now goes out from ${domain}`, { exact: true })).toBeVisible()
  await expect(toggle).toBeChecked()

  const streams = await (await page.request.get(`/api/o/${org.slug}/mail/streams`)).json() as { streams: { id: string, label: string }[] }
  const stream = streams.streams[0]
  test.skip(!stream, 'no stream can follow an org\'s domain')
  await page.getByRole('button', { name: 'Advanced' }).click()
  await pickOption(page, `Domain for ${stream!.label}`, domain)
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Streams saved', { exact: true })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: 'Advanced' }).click()
  await expect(page.getByRole('combobox', { name: `Domain for ${stream!.label}` })).toContainText(domain)
})

test('an org account appears in the add-domain provider picker', async ({ page }) => {
  const { org } = await loginIntoNewOrg(page)
  const label = `${E2E_MAIL_LABEL}-org-acct`

  await page.goto(`/@${org.slug}/settings/email`)
  await page.getByRole('button', { name: 'Advanced' }).click()
  await page.getByRole('button', { name: 'Use our own provider account' }).click()
  const panel = page.getByRole('dialog')
  await pickOption(page, /provider/i, 'Fake provider')
  await panel.getByLabel('Name').fill(label)
  await panel.getByLabel('API key').fill('e2e-api-key')
  await panel.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Account added', { exact: true })).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: label })).toBeVisible()

  await page.getByRole('button', { name: 'Use our own domain' }).click()
  await page.getByRole('dialog').getByText('Fake provider', { exact: true }).click()
  await page.getByRole('combobox', { name: 'Fake provider account' }).click()
  await expect(page.getByRole('option', { name: label })).toBeVisible()
})

test('empty states of a new org', async ({ page }) => {
  const { org } = await loginIntoNewOrg(page)
  await page.goto(`/@${org.slug}/settings/email`)
  await expect(page.getByText(/Your mail is sent from \S+\. Add your own domain to send from it\./)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Use our own domain' })).toBeVisible()
  await expect(page.getByText('No suppressed addresses.')).toBeVisible()

  await page.getByRole('button', { name: 'Advanced' }).click()
  await expect(page.getByText('No accounts of your own. Your domains use the host\'s provider.')).toBeVisible()
  await expect(page.getByText('Add a domain to send or receive mail on it.')).toBeVisible()
})

test('the inbox shows the no-receiving banner until the org\'s domain can receive', async ({ page, browser }) => {
  const host = await useFakeHostAccountForOrgs(browser)
  const { org } = await loginIntoNewOrg(page)
  const sql = getHostAdminDb()
  for (const app of ['inbox', 'crm']) {
    await sql`INSERT INTO apps (id, status) VALUES (${app}, 'available') ON CONFLICT (id) DO UPDATE SET status = coalesce(apps.status, 'available')`
    await sql`INSERT INTO org_apps (org_id, app_id, enabled, source) VALUES (${org.id}, ${app}, true, 'org_admin') ON CONFLICT DO NOTHING`
  }
  const banner = page.getByText('No domain can receive mail yet', { exact: true })

  const firstLoad = page.waitForResponse(r => r.url().includes('/api/inbox/me') && r.ok())
  await page.goto(`/@${org.slug}/inbox`)
  await firstLoad
  await expect(banner).toBeVisible()

  // The org proves a domain, it receives through the host's account, and the inbox stream goes to it.
  const domain = e2eDomain('ib')
  const added = await page.request.post(`/api/o/${org.slug}/mail/domains`, { data: { domain } })
  expect(added.ok()).toBeTruthy()
  const { domain: row } = await added.json() as { domain: { id: string, ownershipRecord: { name: string, value: string } } }
  await fakeControl(page.request, { dns: [{ name: row.ownershipRecord.name, txt: [row.ownershipRecord.value] }] })
  expect((await page.request.post(`/api/o/${org.slug}/mail/domains/${row.id}/verify-ownership`)).ok()).toBeTruthy()
  const checked = await page.request.post(`/api/o/${org.slug}/mail/domains/${row.id}/check`)
  expect(checked.ok()).toBeTruthy()
  const { domain: afterCheck } = await checked.json() as { domain: { sendStatus: string, receiveStatus: string, probeAddress: string | null } }
  expect(afterCheck.sendStatus).toBe('verified')
  if (afterCheck.receiveStatus !== 'verified') {
    await deliverInbound(page.request, host.webhookUrls.inboundMime, 'e2e-signing-key', afterCheck.probeAddress!)
  }
  const routed = await page.request.put(`/api/o/${org.slug}/mail/streams`, { data: { routes: [{ stream: 'inbox', domainId: row.id }] } })
  expect(routed.ok()).toBeTruthy()
  const domains = await (await page.request.get(`/api/o/${org.slug}/mail/domains`)).json() as { domains: { id: string, receiveStatus: string }[] }
  expect(domains.domains.find(d => d.id === row.id)?.receiveStatus).toBe('verified')

  const reload = page.waitForResponse(r => r.url().includes('/api/inbox/me') && r.ok())
  await page.reload()
  const me = await (await reload).json() as { noReceivingDomain: boolean }
  expect(me.noReceivingDomain).toBe(false)
  await expect(banner).toHaveCount(0)
})
