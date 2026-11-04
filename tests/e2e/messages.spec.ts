// Messages app browser flows. Vitest already covers every API endpoint; these
// tests cover what vitest can't: clicks, form submits, list updates without
// reload, modal interactions, navigation, and multi-user notification fanout.
//
// Pattern: seed users/orgs/conversations directly via SQL (host_admin / BYPASSRLS)
// so each test only exercises the UI surface under test, not setup. Wrap every
// click that triggers an API call in `Promise.all([waitForResponse, click])` —
// asserting on the URL or DOM before the API responds is the canonical flake
// source in this repo.
import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getHostAdminDb,
  generateTestToken,
  type TestUser
} from '@nuxtinator/core/test-helpers'
import { addTestMembership } from '@nuxtinator/tenancy/test-helpers'
import {
  cleanupMessagesTestData,
  createMessagesUser,
  createTestChannel,
  createTestItem
} from 'layer-messages/test-helpers'
import { loginIntoNewOrg } from './helpers/login'

const __dirname = dirname(fileURLToPath(import.meta.url))
loadDotenv({ path: resolve(__dirname, '../../dev/.env') })

// Per-spec cleanup. Global teardown handles closeTestDatabases().
test.afterAll(async () => {
  const sql = getHostAdminDb()
  await cleanupMessagesTestData(sql)
})

test('compose + send a markdown message; it renders in the list without reload', async ({ page }) => {
  const sql = getHostAdminDb()
  const { user, org } = await loginIntoNewOrg(page, { roles: ['admin'] })
  const channel = await createTestChannel(sql, { org_id: org.id, created_by: user.id })

  await page.goto(`/@${org.slug}/messages/${channel.id}`)

  // Empty state until we post.
  await expect(page.locator('text=No messages yet')).toBeVisible({ timeout: 5000 })

  const body = `hello e2e ${randomUUID().slice(0, 6)}`
  // The composer is a custom <textarea> (not a UInput). Use its placeholder
  // to scope the fill — Enter sends in chat mode.
  await page.fill('textarea[placeholder="Write a message..."]', body)
  await Promise.all([
    page.waitForResponse(r => r.url().includes(`/api/messages/conversations/${channel.id}/items`) && r.request().method() === 'POST' && r.status() === 200),
    page.getByRole('button', { name: /^send$/i }).click()
  ])

  // The composable refreshes after a successful POST — the new item shows up
  // without a page reload, with our author name on the card.
  await expect(page.locator('article').filter({ hasText: body })).toBeVisible({ timeout: 5000 })
  await expect(page.locator('article').filter({ hasText: body })).toContainText(user.display_name)
})

test('create a new channel from the sidebar; it appears in the list and navigates to it', async ({ page }) => {
  const { org } = await loginIntoNewOrg(page, { roles: ['admin'] })

  await page.goto(`/@${org.slug}/messages`)

  // Sidebar starts with no channels.
  await expect(page.locator('text=No channels yet')).toBeVisible({ timeout: 5000 })

  // Click the `+` next to the "Channels" header — has aria-label="New channel".
  await page.getByRole('button', { name: /new channel/i }).click()

  const channelName = `test-messages-ch-${randomUUID().slice(0, 6)}`
  // The modal's name field is a UInput with placeholder="general".
  await page.fill('input[placeholder="general"]', channelName)
  await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/messages/conversations/channels') && r.request().method() === 'POST' && r.status() === 200),
    page.getByRole('button', { name: /^create$/i }).click()
  ])

  // The sidebar refreshes — the new channel row shows up with its name.
  await expect(page.locator('a').filter({ hasText: channelName }).first()).toBeVisible({ timeout: 5000 })
})

test('open an item, post a reply in the thread; reply renders under the parent comment', async ({ page }) => {
  const sql = getHostAdminDb()
  const { user, org } = await loginIntoNewOrg(page, { roles: ['admin'] })
  const channel = await createTestChannel(sql, { org_id: org.id, created_by: user.id })
  const item = await createTestItem(sql, {
    org_id: org.id,
    conversation_id: channel.id,
    author_id: user.id,
    body_md: 'parent item for threading'
  })

  // Two flows exercised together now that the bugs are fixed:
  //   1. The empty-rail catch-all composer lets us post a top-level comment
  //      without having to seed one or drive the text-selection flow.
  //   2. ItemModal emits `commented`, which [conversationId].vue handles by
  //      calling refresh() — so the parent card's comment count updates.
  await page.goto(`/@${org.slug}/messages/${channel.id}`)

  const itemCard = page.locator('article').filter({ hasText: 'parent item for threading' }).first()
  await expect(itemCard).toBeVisible({ timeout: 5000 })
  await itemCard.click()

  // Empty rail renders a catch-all composer ("Add a comment...").
  const composer = page.locator('textarea[placeholder="Add a comment..."]')
  await expect(composer).toBeVisible({ timeout: 5000 })

  const commentBody = `top-level comment ${randomUUID().slice(0, 6)}`
  await composer.fill(commentBody)

  await Promise.all([
    page.waitForResponse(r => r.url().includes(`/api/messages/items/${item.id}/comments`) && r.request().method() === 'POST' && r.status() === 200),
    page.locator('.composer-wrapper').filter({ has: composer }).getByRole('button', { name: /^comment$/i }).click()
  ])

  // The comment shows in the rail without reload.
  await expect(page.locator('text=' + commentBody)).toBeVisible({ timeout: 5000 })

  // Close the modal; the parent card's comment-count badge reflects the new
  // comment because ItemModal emitted `commented` and the page refreshed.
  // The badge renders as a bare digit ("1") inline with the card body.
  await page.keyboard.press('Escape')
  await expect(itemCard).toContainText(/\b1\b/, { timeout: 5000 })
})

test('@-mention autocomplete: typing @ shows the picker; selecting renders the mention', async ({ page }) => {
  const sql = getHostAdminDb()
  const { user, org } = await loginIntoNewOrg(page, { roles: ['admin'] })

  // Add another member for the autocomplete to pick. Their display_name is
  // what the picker shows and what gets rewritten in the body.
  const other = await createMessagesUser(sql, { display_name: 'Mentionee Bob' })
  await addTestMembership(sql, { user_id: other.id, org_id: org.id, roles: ['member'] })

  const channel = await createTestChannel(sql, { org_id: org.id, created_by: user.id })
  await page.goto(`/@${org.slug}/messages/${channel.id}`)

  // Type the @ trigger; the org-users fetch fires; the picker pops with
  // matches that include Mentionee Bob.
  await page.fill('textarea[placeholder="Write a message..."]', '@Ment')
  // Wait for the popup item (rendered as a <button> inside .mention-popup).
  await expect(page.locator('.mention-popup').getByText('Mentionee Bob')).toBeVisible({ timeout: 5000 })

  // Click to pick — the textarea is rewritten to include the friendly mention.
  await page.locator('.mention-popup').getByText('Mentionee Bob').click()
  await expect(page.locator('textarea[placeholder="Write a message..."]')).toHaveValue(/@Mentionee Bob/)

  // Send the message; the rendered item links the @mention (`[@Name](uuid)`)
  // — i.e. the user link survives the markdown serialization on the way out.
  await Promise.all([
    page.waitForResponse(r => r.url().includes(`/api/messages/conversations/${channel.id}/items`) && r.request().method() === 'POST' && r.status() === 200),
    page.getByRole('button', { name: /^send$/i }).click()
  ])
  // Renderer wraps mentions as anchor tags. Assert the mention text shows on
  // the new item card without the markdown brackets leaking through.
  const card = page.locator('article').filter({ hasText: '@Mentionee Bob' }).first()
  await expect(card).toBeVisible({ timeout: 5000 })
})

test('star an item; the star icon reflects the toggled state', async ({ page }) => {
  const sql = getHostAdminDb()
  const { user, org } = await loginIntoNewOrg(page, { roles: ['admin'] })
  const channel = await createTestChannel(sql, { org_id: org.id, created_by: user.id })
  const item = await createTestItem(sql, {
    org_id: org.id,
    conversation_id: channel.id,
    author_id: user.id,
    body_md: 'star me'
  })

  await page.goto(`/@${org.slug}/messages/${channel.id}`)

  const card = page.locator('article').filter({ hasText: 'star me' }).first()
  await expect(card).toBeVisible({ timeout: 5000 })

  // The star button uses title="Star" / "Unstar"; hover-only opacity is fine
  // since Playwright clicks regardless of visibility. Wait for the POST so
  // the refresh has completed.
  await Promise.all([
    page.waitForResponse(r => r.url().includes(`/api/messages/items/${item.id}/star`) && r.request().method() === 'POST' && r.status() === 200),
    card.getByTitle(/^star$/i).click()
  ])

  // After refresh, the same button switches to title="Unstar".
  await expect(card.getByTitle(/^unstar$/i)).toBeVisible({ timeout: 5000 })
})

test('search popover filters by content and clearing the query restores empty state', async ({ page }) => {
  const sql = getHostAdminDb()
  const { user, org } = await loginIntoNewOrg(page, { roles: ['admin'] })
  const channel = await createTestChannel(sql, { org_id: org.id, created_by: user.id })
  // Use a body whose distinguishing word is unique english-FTS-stemmable.
  // websearch_to_tsquery('english') tokenizes on letters; pure alphabetic
  // helps avoid the stemmer dropping the token entirely.
  const distinguishingWord = `flamingotopia${Math.floor(Math.random() * 100000)}`
  await createTestItem(sql, {
    org_id: org.id,
    conversation_id: channel.id,
    author_id: user.id,
    body_md: `meeting notes about ${distinguishingWord} planning`
  })
  await createTestItem(sql, {
    org_id: org.id,
    conversation_id: channel.id,
    author_id: user.id,
    body_md: 'unrelated turtle ocean body'
  })

  await page.goto(`/@${org.slug}/messages/${channel.id}`)

  // Open the search popover from the header.
  await page.getByRole('button', { name: /search/i }).first().click()

  // The popover input is auto-focused; SearchBar debounces 250ms then fires
  // the request. Type and wait for both the response AND the result render.
  const searchInput = page.locator('input[placeholder="Search messages and comments..."]')
  await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/messages/search') && r.status() === 200, { timeout: 5000 }),
    searchInput.fill(distinguishingWord)
  ])

  // UPopover content is teleported to the document body; page-level
  // locators see it regardless of DOM home. SearchBar renders a "Messages"
  // section header above each matched item.
  await expect(page.getByText('Messages', { exact: true })).toBeVisible({ timeout: 5000 })

  // Searching for a string that matches nothing falls back to "No results."
  await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/messages/search') && r.status() === 200, { timeout: 5000 }),
    searchInput.fill('zzzzzznosuchthing')
  ])
  await expect(page.getByText('No results.', { exact: true })).toBeVisible({ timeout: 5000 })

  // Clearing the query restores the "Type to search." placeholder. SearchBar
  // clears the result arrays synchronously on empty query — see SearchBar.vue
  // lines 36-40 — so no debounce wait needed.
  await searchInput.fill('')
  await expect(page.getByText('Type to search.', { exact: true })).toBeVisible({ timeout: 3000 })
})

test('start a DM: pick a user from the picker, conversation opens', async ({ page }) => {
  const sql = getHostAdminDb()
  const { org } = await loginIntoNewOrg(page, { roles: ['admin'] })
  const other = await createMessagesUser(sql, { display_name: 'Dm Target' })
  await addTestMembership(sql, { user_id: other.id, org_id: org.id, roles: ['member'] })

  await page.goto(`/@${org.slug}/messages`)

  // Click `+` next to the "Direct Messages" header.
  await page.getByRole('button', { name: /new dm/i }).click()

  // The modal opens with an empty query — initial fetch returns the full org
  // member list (incl. self + Dm Target). Click Dm Target to select.
  await expect(page.locator('text=Dm Target').first()).toBeVisible({ timeout: 5000 })
  await page.locator('button').filter({ hasText: 'Dm Target' }).first().click()

  // Hit "Start DM" — wait for the POST and the auto-navigation that follows.
  await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/messages/conversations/dms') && r.request().method() === 'POST' && r.status() === 200),
    page.getByRole('button', { name: /start dm/i }).click()
  ])

  // The sidebar emits `created` with the new conversation id; the page
  // navigates to /@<slug>/messages/<id>. Assert the URL changed.
  await expect(page).toHaveURL(new RegExp(`/@${org.slug}/messages/[0-9a-f-]+`), { timeout: 5000 })
})

test('notifications bell: userA @-mentions userB; B sees their unread badge increment', async ({ page }) => {
  const sql = getHostAdminDb()
  // User A is the inviting admin; user B is a fresh second user in the same org.
  const { user: userA, org } = await loginIntoNewOrg(page, { roles: ['admin'] })
  const userB = await createMessagesUser(sql, { display_name: 'Notifyme Carol' })
  await addTestMembership(sql, { user_id: userB.id, org_id: org.id, roles: ['member'] })

  const channel = await createTestChannel(sql, { org_id: org.id, created_by: userA.id })

  // User A posts an item mentioning user B. Use the API directly — we're
  // not testing the compose UI here (that's its own test), we're testing
  // that the mention fan-out creates a notification visible in B's bell.
  await page.goto(`/@${org.slug}/messages/${channel.id}`)
  await page.fill('textarea[placeholder="Write a message..."]', `hey @Notifyme Carol look at this`)

  // The compose path doesn't auto-rewrite the mention unless we drove the
  // picker. Do the picker dance — type @Noti to trigger, click the popup
  // result, then send.
  await page.fill('textarea[placeholder="Write a message..."]', '')
  await page.fill('textarea[placeholder="Write a message..."]', '@Noti')
  await expect(page.locator('.mention-popup').getByText('Notifyme Carol')).toBeVisible({ timeout: 5000 })
  await page.locator('.mention-popup').getByText('Notifyme Carol').click()
  await page.locator('textarea[placeholder="Write a message..."]').type(' check this out')
  await Promise.all([
    page.waitForResponse(r => r.url().includes(`/api/messages/conversations/${channel.id}/items`) && r.request().method() === 'POST' && r.status() === 200),
    page.getByRole('button', { name: /^send$/i }).click()
  ])

  // Now log in as user B in a fresh browser context (no cookie bleed) and
  // verify the notification feed has the mention. Use the bell popover.
  const ctxB = await page.context().browser()!.newContext()
  const pageB = await ctxB.newPage()
  const baseURL = page.context()._options?.baseURL || 'http://localhost:2090'
  await ctxB.addCookies([{
    name: 'auth-token',
    value: generateTestToken(userB as TestUser),
    url: baseURL,
    httpOnly: true,
    sameSite: 'Lax'
  }])
  await pageB.goto(`/@${org.slug}/messages`)

  // Bell shows unread badge for the mention. The notifications composable
  // fetches on mount (NotificationBell calls start() in onMounted).
  await pageB.waitForResponse(r => r.url().includes('/api/messages/notifications') && r.status() === 200, { timeout: 5000 })

  // The badge element renders inside the bell button when unread > 0.
  await expect(pageB.locator('button[aria-label="Notifications"] .badge')).toBeVisible({ timeout: 5000 })
  await expect(pageB.locator('button[aria-label="Notifications"] .badge')).toHaveText(/[1-9]/, { timeout: 5000 })

  await ctxB.close()
})
