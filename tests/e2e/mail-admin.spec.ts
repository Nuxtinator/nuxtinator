// Host admin mail UI (/admin/email): accounts, manual and automatic domains,
// stream routing and suppressions, against the fake provider and fake DNS.
// Needs a server started with MAIL_FAKE_PROVIDER=1 and MAIL_TRANSPORT=provider.
import { test, expect, type Page } from '@playwright/test'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestDatabases, cleanupCoreTestData, getHostAdminDb } from '@nuxtinator/core/test-helpers'
import { loginAsNewUser } from './helpers/login'
import {
  E2E_MAIL_LABEL, cleanupMailTestData, deliverInbound, e2eDomain, fakeAvailable, fakeControl, insertSuppression, pickOption
} from './helpers/mail'

const __dirname = dirname(fileURLToPath(import.meta.url))
loadDotenv({ path: resolve(__dirname, '../../dev/.env') })

const SIGNING_KEY = 'e2e-signing-key'

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  test.skip(!await fakeAvailable(page.request), 'needs MAIL_FAKE_PROVIDER=1 on the server')
  await fakeControl(page.request, { reset: true, deliver: false })
  await loginAsNewUser(page, { is_admin: true })
})

test.afterAll(async () => {
  await cleanupMailTestData()
  await cleanupCoreTestData(getHostAdminDb())
  await closeTestDatabases()
})

async function addFakeAccount(page: Page, label: string) {
  await page.goto('/admin/email?tab=accounts')
  await page.getByRole('button', { name: 'Add account' }).click()
  const panel = page.getByRole('dialog')
  await pickOption(page, /provider/i, 'Fake provider')
  await panel.getByLabel('Name').fill(label)
  await panel.getByLabel('API key').fill('e2e-api-key')
  await panel.getByLabel('Webhook signing key').fill(SIGNING_KEY)
  await panel.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Account added', { exact: true })).toBeVisible()
  return page.getByRole('row').filter({ hasText: label })
}

async function addDomain(page: Page, opts: { domain: string, account: string, receive?: boolean, auto?: boolean }) {
  await page.goto('/admin/email?tab=domains')
  await page.getByRole('button', { name: 'Add domain' }).click()
  const modal = page.getByRole('dialog')
  await modal.getByText('Fake provider', { exact: true }).click()
  await modal.getByRole('textbox', { name: /^Domain/ }).fill(opts.domain)
  await pickOption(page, 'Fake provider account', opts.account)
  if (opts.receive) await modal.getByRole('switch', { name: /Receive email on this domain/ }).click()
  await modal.getByRole('checkbox', { name: 'Make this the default domain' }).setChecked(false)
  await modal.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(page.getByText(`${opts.domain} added`, { exact: true })).toBeVisible()
  const panel = page.getByRole('dialog', { name: opts.domain })
  if (opts.auto) {
    await panel.getByRole('button', { name: 'Set it up for me' }).click()
    await page.getByRole('button', { name: 'Set it up', exact: true }).click()
    await expect(page.getByText('Set up at the provider', { exact: true })).toBeVisible()
  }
  return panel
}

test('add an account: the key is checked and its capabilities are listed', async ({ page }) => {
  const label = `${E2E_MAIL_LABEL}-acct`
  const row = await addFakeAccount(page, label)
  await expect(row).toBeVisible()
  // With no domain yet, nothing that needs one has been probed.
  await expect(row.getByTitle('Not tested yet').filter({ hasText: 'Suppression lists' })).toBeVisible()

  await row.getByRole('button', { name: 'Account actions' }).click()
  await page.getByRole('menuitem', { name: 'Check the key' }).click()
  await expect(page.getByText('Key checked', { exact: true })).toBeVisible()

  // Secrets come back masked and write-only.
  await row.getByText(label).click()
  const panel = page.getByRole('dialog')
  await expect(panel.getByText('••••-key').first()).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Replace' }).first()).toBeVisible()

  // Its first domain probes the rest, and the list shows what the key can do.
  await addDomain(page, { domain: e2eDomain('caps'), account: label })
  await page.goto('/admin/email?tab=accounts')
  const probed = page.getByRole('row').filter({ hasText: label })
  await expect(probed.getByTitle('Allowed', { exact: true }).filter({ hasText: 'Send' })).toBeVisible()
  await expect(probed.getByTitle('Allowed', { exact: true }).filter({ hasText: 'Suppression lists' })).toBeVisible()
})

test('a manual domain shows steps, then verifies sending and receiving', async ({ page }) => {
  const label = `${E2E_MAIL_LABEL}-manual`
  await addFakeAccount(page, label)
  const domain = e2eDomain('m')
  const panel = await addDomain(page, { domain, account: label, receive: true })

  await expect(panel.getByText(`Add ${domain} at the fake provider`)).toBeVisible()
  await expect(panel.getByText('Priority')).toHaveCount(0)

  await panel.getByRole('button', { name: 'Verify sending' }).click()
  await expect(panel.getByText('Provider accepted a test')).toBeVisible()
  await expect(panel.getByText('DNS: SPF, DKIM and DMARC records found')).toBeVisible()
  const sending = panel.locator('section').filter({ has: page.getByRole('heading', { name: 'Sending' }) })
  await expect(sending.getByText('Verified')).toBeVisible()

  const probe = (await panel.getByText(/^nx-probe-.*@/).textContent())!.trim()
  await panel.getByRole('button', { name: 'Verify receiving' }).click()
  await expect(panel.getByText(`Probe sent to ${probe}`)).toBeVisible()

  const accounts = await (await page.request.get('/api/admin/mail/accounts')).json() as { accounts: { label: string, webhookUrls: { inboundMime: string } }[] }
  const account = accounts.accounts.find(a => a.label === label)!
  await deliverInbound(page.request, account.webhookUrls.inboundMime, SIGNING_KEY, probe)

  await panel.getByRole('button', { name: 'Verify receiving' }).click()
  const receiving = panel.locator('section').filter({ has: page.getByRole('heading', { name: 'Receiving' }) })
  await expect(receiving.getByText('Verified')).toBeVisible()
})

test('an automatic domain shows its DNS records and goes green on Check now', async ({ page }) => {
  const label = `${E2E_MAIL_LABEL}-auto`
  await fakeControl(page.request, { adminKey: true })
  await addFakeAccount(page, label)
  const domain = e2eDomain('a')
  await fakeControl(page.request, { domainStatus: 'verified', dns: [{ name: domain, mx: [{ exchange: 'mx.elsewhere.example', priority: 10 }] }] })
  const panel = await addDomain(page, { domain, account: label, receive: true, auto: true })

  await expect(panel.getByText(`${domain} already receives mail`)).toBeVisible()
  await expect(panel.getByText('v=spf1 include:fake.example ~all')).toBeVisible()
  await expect(panel.getByText('mx.fake.example')).toBeVisible()

  await panel.getByRole('button', { name: 'Check now' }).click()
  await expect(panel.locator('section').filter({ has: page.getByRole('heading', { name: 'Sending' }) }).getByText('Verified').first()).toBeVisible()
  await expect(panel.locator('section').filter({ has: page.getByRole('heading', { name: 'Receiving' }) }).getByText('Verified').first()).toBeVisible()
})

test('the inbox stream offers only domains that receive, and a pick persists', async ({ page, request }) => {
  const streams = await (await page.request.get('/api/admin/mail/streams')).json() as { streams: { id: string }[] }
  test.skip(!streams.streams.some(s => s.id === 'inbox'), 'no inbox stream registered')
  const label = `${E2E_MAIL_LABEL}-streams`
  await fakeControl(request, { adminKey: true, domainStatus: 'verified' })
  await addFakeAccount(page, label)
  const sendOnly = e2eDomain('s')
  const both = e2eDomain('b')
  await addDomain(page, { domain: sendOnly, account: label, auto: true })
  await page.getByRole('dialog', { name: sendOnly }).getByRole('button', { name: 'Check now' }).click()
  await expect(page.getByRole('dialog', { name: sendOnly }).getByText('Verified').first()).toBeVisible()
  await addDomain(page, { domain: both, account: label, receive: true, auto: true })
  await page.getByRole('dialog', { name: both }).getByRole('button', { name: 'Check now' }).click()
  await expect(page.getByRole('dialog', { name: both }).getByText('Verified').first()).toBeVisible()

  await page.goto('/admin/email?tab=streams')
  await page.getByRole('combobox', { name: 'Domain for Inbox' }).click()
  await expect(page.getByRole('option', { name: both })).toBeVisible()
  await expect(page.getByRole('option', { name: sendOnly })).toHaveCount(0)
  await page.getByRole('option', { name: both }).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Streams saved', { exact: true })).toBeVisible()

  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Domain for Inbox' })).toContainText(both)
})

test('suppression search shows the address and Clear removes the row', async ({ page }) => {
  const address = `bounce-${Date.now()}@example.org`
  await insertSuppression({ address, reason: 'hard_bounce', scope: 'global' })
  await page.goto('/admin/email?tab=suppressions')
  await page.getByRole('textbox', { name: 'Search an address' }).fill(address)
  const row = page.getByRole('row').filter({ hasText: address })
  await expect(row).toBeVisible()
  await expect(row.getByText('Hard bounce')).toBeVisible()

  await row.getByRole('button', { name: 'Clear' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Clear' }).click()
  await expect(page.getByText('Suppression cleared', { exact: true })).toBeVisible()
  await expect(page.getByText('Nothing is suppressed for that address.')).toBeVisible()
})

test('a domain whose provider list is unmanaged shows the warning', async ({ page, request }) => {
  const label = `${E2E_MAIL_LABEL}-unmanaged`
  await addFakeAccount(page, label)
  await fakeControl(request, { mode: 'unmanaged' })
  const domain = e2eDomain('u')
  await addDomain(page, { domain, account: label })
  await page.goto('/admin/email?tab=suppressions')
  await expect(page.getByText(`The provider also blocks addresses on`)).toBeVisible()
  await expect(page.getByText(domain)).toBeVisible()
})

// The env account and the other tests' rows mean the real lists are never
// empty here, so the list endpoints answer as on a fresh database.
test('empty states', async ({ page }) => {
  await page.route('**/api/admin/mail/accounts', route => route.fulfill({ json: { accounts: [], orgAccounts: [], providers: [], outboxPublicKey: null, transport: 'provider' } }))
  await page.route('**/api/admin/mail/domains', route => route.fulfill({ json: { domains: [] } }))
  await page.route('**/api/admin/mail/suppressions**', route => route.fulfill({ json: { suppressions: [] } }))

  await page.goto('/admin/email')
  await expect(page.getByText('Mail isn\'t configured. Add a domain to send password resets and invites.')).toBeVisible()

  await page.goto('/admin/email?tab=accounts')
  await expect(page.getByText('No provider keys yet. Adding a domain saves its key here.')).toBeVisible()

  await page.goto('/admin/email?tab=suppressions')
  await expect(page.getByText('No suppressed addresses.')).toBeVisible()
  await page.getByRole('textbox', { name: 'Search an address' }).fill(`nobody-${Date.now()}@example.org`)
  await expect(page.getByText('Nothing is suppressed for that address.')).toBeVisible()
})
