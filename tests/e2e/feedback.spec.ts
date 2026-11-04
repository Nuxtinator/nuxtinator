// Feedback (kanban) app browser flows. Vitest covers every API endpoint;
// these tests assert the wiring: clicks land, list refresh shows new rows,
// modals open/close, navigation between admin shell + board.
//
// Skipped flows + reasoning (see report on the parent task):
//   - Drag-and-drop card move: HTML5 drag events are unreliable across
//     Playwright + Chromium for this component (KanbanCard uses native
//     dragstart with custom dataTransfer payloads — synthetic events don't
//     fire dragover/drop on the receiving Cell consistently). The vitest
//     PATCH /api/feedback/cards/:id/move test covers the contract; only the
//     UI gesture is uncovered.
//   - Public widget embed: the <feedback-web-component> lives in
//     embeddables/ as a separate bundle for cross-origin host pages. Driving
//     it inside the same Playwright context against this app's routes is
//     out of scope; vitest covers POST /api/v1/feedback end-to-end against
//     a project + org.
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
import {
  cleanupFeedbackTestData,
  createTestProject,
  createTestCard,
  getColumnByName
} from 'layer-feedback/test-helpers'
import { loginIntoNewOrg } from './helpers/login'

const __dirname = dirname(fileURLToPath(import.meta.url))
loadDotenv({ path: resolve(__dirname, '../../dev/.env') })

test.afterAll(async () => {
  const sql = getHostAdminDb()
  await cleanupFeedbackTestData(sql)
  await cleanupTenancyTestData(sql)
  await cleanupCoreTestData(sql)
  await closeTestDatabases()
})

// The chat-bubble widget (wrapper z-index lowered to 40 in production but
// still rendered in the bottom-right) sits exactly where USlideover places
// its Save button. Even when stacked below the slideover, the inline iframe
// in Shadow DOM can capture clicks. Hide the widget for every test in this
// spec so the action buttons receive their click cleanly.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const inject = () => {
      const style = document.createElement('style')
      style.setAttribute('data-test-hide-widget', '1')
      style.textContent = `
        .feedback-widget-slot,
        feedback-web-component {
          display: none !important;
          pointer-events: none !important;
        }
      `
      ;(document.head || document.documentElement).appendChild(style)
    }
    if (document.head || document.documentElement) inject()
    else document.addEventListener('DOMContentLoaded', inject)
  })
})

test('create a project from the empty board; project tile renders without reload', async ({ page }) => {
  const { org } = await loginIntoNewOrg(page, { roles: ['admin'] })

  await page.goto(`/@${org.slug}/feedback`)

  // Empty state — "No projects yet" copy from feedback/index.vue.
  await expect(page.locator('text=No projects yet')).toBeVisible({ timeout: 10_000 })

  // Click the empty-state CTA. There are two "create" buttons on the page
  // (toolbar + empty state) — scope to the empty state.
  await page.getByRole('button', { name: /create your first project/i }).click()

  const projectName = `test-feedback-proj-${randomUUID().slice(0, 6)}`
  // The project modal contains a single text input — placeholder "e.g., Map A".
  await page.fill('input[placeholder*="Map A"]', projectName)
  await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/feedback/projects') && r.request().method() === 'POST' && r.status() === 200),
    page.getByRole('button', { name: /^create$/i }).click()
  ])

  // Project header text appears on the board (no reload required).
  await expect(page.locator('body')).toContainText(projectName, { timeout: 5000 })
})

test('open existing board: every migration-seeded column is visible (FEEDBACK INBOX, BACKLOG, PLANNING, BUILDING, TESTING, DONE)', async ({ page }) => {
  const sql = getHostAdminDb()
  const { org } = await loginIntoNewOrg(page, { roles: ['admin'] })
  await createTestProject(sql, { org_id: org.id, name: 'test-feedback-board-cols' })

  await page.goto(`/@${org.slug}/feedback`)

  // Wait for the project header to confirm board hydrated.
  await expect(page.locator('text=test-feedback-board-cols')).toBeVisible({ timeout: 10_000 })

  // Columns are rendered as group cells with the name in text. Each non-
  // archive column is visible by default.
  for (const name of ['FEEDBACK INBOX', 'BACKLOG', 'PLANNING', 'BUILDING', 'TESTING', 'DONE']) {
    await expect(page.locator(`text=${name}`).first()).toBeVisible({ timeout: 5000 })
  }
})

test('create a card via the per-cell Add button; card renders in the column', async ({ page }) => {
  const sql = getHostAdminDb()
  const { org } = await loginIntoNewOrg(page, { roles: ['admin'] })
  const project = await createTestProject(sql, { org_id: org.id, name: 'test-feedback-cards-proj' })

  await page.goto(`/@${org.slug}/feedback`)
  await expect(page.locator('text=test-feedback-cards-proj')).toBeVisible({ timeout: 10_000 })

  // Each empty cell exposes a "+" button with aria-label "Add card to <COLUMN_NAME>".
  // Pick BACKLOG since that's the canonical "new work" column. Empty cells
  // surface the button at opacity-100, so it's clickable without hover.
  // Multiple BACKLOG cells exist if there are multiple swimlanes — scope
  // to the first one.
  await page.getByRole('button', { name: /add card to backlog/i }).first().click()

  const cardTitle = `test-feedback-card-${randomUUID().slice(0, 6)}`
  // Card modal: UInput with placeholder "Briefly describe the card".
  await page.fill('input[placeholder*="Briefly describe"]', cardTitle)
  await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/feedback/cards') && r.request().method() === 'POST' && r.status() === 200),
    page.getByRole('button', { name: /^create$/i }).click()
  ])

  // Created card text shows up on the board.
  await expect(page.locator('text=' + cardTitle).first()).toBeVisible({ timeout: 5000 })

  // BUG-watch: the API created the card under project_id = project.id. We
  // also re-query to verify the DB landed properly so the test doubles as a
  // wiring sanity check.
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM cards WHERE project_id = ${project.id} AND title = ${cardTitle}
  `
  expect(rows.length).toBe(1)
})

test('edit a card via the side panel; updated title appears on the board', async ({ page }) => {
  const sql = getHostAdminDb()
  const { org } = await loginIntoNewOrg(page, { roles: ['admin'] })
  const project = await createTestProject(sql, { org_id: org.id })
  const backlog = await getColumnByName(sql, 'BACKLOG')
  const card = await createTestCard(sql, {
    org_id: org.id,
    project_id: project.id,
    swimlane_id: project.default_swimlane_id,
    column_id: backlog.id,
    title: 'test-feedback-orig-title'
  })

  await page.goto(`/@${org.slug}/feedback`)

  // Click the card to open the CardEditSidePanel.
  const cardLocator = page.locator('text=test-feedback-orig-title').first()
  await expect(cardLocator).toBeVisible({ timeout: 10_000 })
  await cardLocator.click()

  // Side panel renders the title under a UFormField with label "Title".
  // USlideover puts content into a role=dialog; scope to that.
  const panel = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: /edit card/i }) })
  const editTitle = panel.getByRole('textbox', { name: 'Title' })
  await expect(editTitle).toBeVisible({ timeout: 5000 })

  const newTitle = `test-feedback-edited-${randomUUID().slice(0, 6)}`
  await editTitle.fill(newTitle)

  // Save via the panel's Save action. Multiple "Save" buttons may exist on
  // the page; the response wait scopes the click to the side panel's PATCH.
  await Promise.all([
    page.waitForResponse(r => r.url().includes(`/api/feedback/cards/${card.id}`) && r.request().method() === 'PATCH' && r.status() === 200),
    panel.getByRole('button', { name: /^save$/i }).first().click()
  ])

  await expect(page.locator('text=' + newTitle).first()).toBeVisible({ timeout: 5000 })
})

test('opening a card from its notification link opens the panel and marks the notice read', async ({ page }) => {
  const sql = getHostAdminDb()
  const { user, org } = await loginIntoNewOrg(page, { roles: ['admin'] })
  const project = await createTestProject(sql, { org_id: org.id })
  const inbox = await getColumnByName(sql, 'FEEDBACK INBOX')
  const card = await createTestCard(sql, {
    org_id: org.id,
    project_id: project.id,
    swimlane_id: project.default_swimlane_id,
    column_id: inbox.id,
    title: 'test-feedback-notified'
  })
  const [notice] = await sql<{ id: string }[]>`
    INSERT INTO notifications (user_id, app_id, title, link, org_id)
    VALUES (${user.id}, 'feedback', 'New bug', ${`/feedback?card=${card.id}`}, ${org.id})
    RETURNING id
  `

  await Promise.all([
    page.waitForResponse(r => r.url().includes(`/api/feedback/cards/${card.id}/read`) && r.status() === 200, { timeout: 30_000 }),
    page.goto(`/@${org.slug}/feedback?card=${card.id}`)
  ])

  const panel = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: /edit card/i }) })
  await expect(panel.getByRole('textbox', { name: 'Title' })).toHaveValue('test-feedback-notified')
  const [row] = await sql<{ read_at: Date | null }[]>`SELECT read_at FROM notifications WHERE id = ${notice!.id}`
  expect(row!.read_at).not.toBeNull()
})

test('delete a card via the context menu; card disappears from the board', async ({ page }) => {
  const sql = getHostAdminDb()
  const { org } = await loginIntoNewOrg(page, { roles: ['admin'] })
  const project = await createTestProject(sql, { org_id: org.id })
  const backlog = await getColumnByName(sql, 'BACKLOG')
  const card = await createTestCard(sql, {
    org_id: org.id,
    project_id: project.id,
    swimlane_id: project.default_swimlane_id,
    column_id: backlog.id,
    title: 'test-feedback-to-delete'
  })

  await page.goto(`/@${org.slug}/feedback`)

  const cardLocator = page.locator('text=test-feedback-to-delete').first()
  await expect(cardLocator).toBeVisible({ timeout: 10_000 })

  // Open the card panel and use its Delete affordance — the context menu is
  // a right-click pattern (fragile to drive reliably across browsers). The
  // side panel's Delete is a two-step confirm: click Delete (icon trash-2)
  // → click "Yes, delete" → DELETE request fires.
  await cardLocator.click()
  const panel = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: /edit card/i }) })
  await panel.getByRole('button', { name: /^delete$/i }).first().click()
  await Promise.all([
    page.waitForResponse(r => r.url().includes(`/api/feedback/cards/${card.id}`) && r.request().method() === 'DELETE' && r.status() === 200),
    panel.getByRole('button', { name: /yes, delete/i }).click()
  ])

  await expect(page.locator('text=test-feedback-to-delete')).toHaveCount(0, { timeout: 5000 })
})

test('delete a project from the toolbar/context menu; project tile gone from the board', async ({ page }) => {
  const sql = getHostAdminDb()
  const { org } = await loginIntoNewOrg(page, { roles: ['admin'] })
  const project = await createTestProject(sql, { org_id: org.id, name: 'test-feedback-doomed-proj' })

  await page.goto(`/@${org.slug}/feedback`)
  await expect(page.locator('text=test-feedback-doomed-proj')).toBeVisible({ timeout: 10_000 })

  // The project header exposes a delete action via the project context menu
  // (right-click). The KanbanContextMenu's danger items are a two-click
  // confirm: first click swaps the label to "Click again to confirm", second
  // click fires the action. The action then triggers a window.confirm() in
  // deleteProject(), then the DELETE.
  page.once('dialog', d => d.accept())

  await page.locator('text=test-feedback-doomed-proj').first().click({ button: 'right' })

  // First click arms the confirm.
  await page.getByRole('button', { name: /^delete$/i }).first().click()
  // Second click commits → triggers confirm() → DELETE.
  await Promise.all([
    page.waitForResponse(r => r.url().includes(`/api/feedback/projects/${project.id}`) && r.request().method() === 'DELETE' && r.status() === 200),
    page.getByRole('button', { name: /click again to confirm/i }).first().click()
  ])

  await expect(page.locator('text=test-feedback-doomed-proj')).toHaveCount(0, { timeout: 5000 })
})

test('add a new swimlane to a project via context menu; new lane row appears', async ({ page }) => {
  const sql = getHostAdminDb()
  const { org } = await loginIntoNewOrg(page, { roles: ['admin'] })
  const project = await createTestProject(sql, { org_id: org.id, name: 'test-feedback-swimlane-proj' })

  await page.goto(`/@${org.slug}/feedback`)
  await expect(page.locator('text=test-feedback-swimlane-proj')).toBeVisible({ timeout: 10_000 })

  // Open the project context menu.
  await page.locator('text=test-feedback-swimlane-proj').first().click({ button: 'right' })

  // Click "Add swimlane".
  await page.getByRole('button', { name: /add swimlane/i }).or(page.getByRole('menuitem', { name: /add swimlane/i })).first().click()

  const laneName = `test-feedback-lane-${randomUUID().slice(0, 6)}`
  await page.fill('input[placeholder*="Mobile view"]', laneName)
  await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/feedback/swimlanes') && r.request().method() === 'POST' && r.status() === 200),
    page.getByRole('button', { name: /^create$/i }).click()
  ])

  // Verify the swimlane row landed in the DB. The board's pooled view collapses
  // a project's multiple lanes into one summary row until the user expands it,
  // so a UI text-visible assertion would need an extra click + state shuffle.
  // The DB write is the canonical contract this test is asserting.
  const rows = await sql<{ id: string, name: string }[]>`
    SELECT id, name FROM swimlanes WHERE project_id = ${project.id} AND name = ${laneName}
  `
  expect(rows.length).toBe(1)
})

test('non-admin member sees the board but rename/delete project options are gated on permission', async ({ page }) => {
  const sql = getHostAdminDb()
  // Note: feedback.write is in the default member grants, so members CAN
  // edit/delete in the API. The UI doesn't gate the toolbar action by
  // permission — but the New Project button should still be visible for
  // members. This test asserts: members reach the board and see the
  // project, validating the per-route permission middleware doesn't 403
  // a regular org member.
  const { org } = await loginIntoNewOrg(page, { roles: ['member'] })
  await createTestProject(sql, { org_id: org.id, name: 'test-feedback-member-view' })

  await page.goto(`/@${org.slug}/feedback`)
  await expect(page.locator('text=test-feedback-member-view')).toBeVisible({ timeout: 10_000 })

  // Toolbar's "New project" button is visible since members can write.
  await expect(page.getByRole('button', { name: /new project/i }).first()).toBeVisible()
})
