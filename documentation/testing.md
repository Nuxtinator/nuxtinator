# Testing

How tests are organized, how to run them, and how to add new ones.

## Quick start

```bash
# One-time: provision the test database + roles. Re-runnable.
cd dev && bun run test:db

# Append the printed TEST_DATABASE_URL + TEST_APP_DATABASE_URL to dev/.env.

# Make sure Mailpit (or MailHog) is running on :1025 (SMTP) + :8025 (HTTP API).
# This repo's docker-compose at the project root already runs it.

# Run the test suite.
bun run test          # vitest API tests (~30s)
bun run test:e2e      # Playwright browser smoke test
bun run test:watch    # vitest watch mode
```

`bun run test` always finishes with a plain-text summary box even when piped:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Test Files: 46/46 passed
  Tests:      122/122 passed
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

`bun test` (no `run`) invokes Bun's own test runner and won't find the suites — always use `bun run test`.

## Philosophy

Two non-negotiables:

1. **Tests hit real endpoints.** Vitest spins up a real Nuxt server (via `@nuxt/test-utils/e2e`) against a real Postgres. `$fetch('/api/...')` round-trips through the actual handler, middleware, and DB. No mocked Nuxt, no mocked DB.
2. **No "logic ✓" tests.** A test that re-implements the function it's testing and asserts the two agree (`expect(2).toBe(2)`) tells you nothing. Tests assert observable *behavior* — the response status/body, what landed in the DB, what email was sent — not the function's internal control flow.

## Architecture

### Layout

```
go-saas/
├── scripts/
│   └── setup-test-db.sh             ← provisions go_saas_test + host_admin / app_user roles
├── dev/
│   ├── vitest.config.ts             ← one project per layer
│   ├── playwright.config.ts         ← self-starts Nuxt on :2090 against test DB
│   └── scripts/run-tests.mjs        ← wrapper that prints a TTY-safe summary
├── tests/e2e/                       ← Playwright tests (host-level multi-layer flows)
│   ├── global-setup.ts
│   ├── global-teardown.ts
│   ├── helpers/login.ts
│   └── smoke/*.spec.ts
└── layers/
    ├── core/tests/                  ← core's tests
    │   ├── global-setup.ts
    │   ├── helpers/                 ← exported as `@nuxtinator/core/test-helpers`
    │   │   ├── index.ts
    │   │   ├── db.ts                ← getHostAdminDb / getAppUserDb / cleanupCoreTestData
    │   │   ├── auth.ts              ← createTestUser / generateTestToken / getAuthHeaders
    │   │   ├── mailhog.ts           ← waitForMailTo / extractTokenFromBody / clearMailhog
    │   │   └── invites.ts           ← createPendingInvite (password=null users)
    │   └── auth/*.test.ts
    └── tenancy/tests/
        ├── global-setup.ts
        ├── helpers/                 ← exported as `@nuxtinator/tenancy/test-helpers`
        │   ├── index.ts             ← re-exports core helpers + tenancy helpers
        │   └── orgs.ts              ← createTestOrg / addTestMembership / createOrgWithAdmin / withOrgHeader
        └── orgs/*.test.ts
```

Tests live with their layer. Cross-layer helper imports go through each layer's `package.json` `exports` map (`import { createTestUser } from '@nuxtinator/core/test-helpers'`).

### Vitest projects

Each layer is a vitest project. Projects run in parallel; files within a project run serial (`fileParallelism: false`). Each layer prefixes its test data (`test-core-…`, `test-tenancy-…`) so layers running in parallel never collide.

To add a new layer's tests, append a `layerProject(...)` entry to [dev/vitest.config.ts](../dev/vitest.config.ts):

```ts
projects: [
  layerProject('core',     '../layers/core/tests'),
  layerProject('tenancy',  '../layers/tenancy/tests'),
  layerProject('messages', '../layers/apps/messages/tests')   // <— new
]
```

### Database

`scripts/setup-test-db.sh` provisions the test DB to mirror prod's role split:

- `host_admin` role with `BYPASSRLS` — used by migrations and the tenancy layer's `adminDb`. Test setup uses this for seeding (since RLS would block plain INSERTs into tenant tables outside the `defineTenantHandler` txn).
- `app_user` role with normal RLS enforcement — what the spawned Nuxt server's `db` client connects as. This is what catches RLS bugs.

Two env vars in `dev/.env` map to the two roles:

```
TEST_DATABASE_URL=postgresql://host_admin:test@localhost:5432/go_saas_test
TEST_APP_DATABASE_URL=postgresql://app_user:test@localhost:5432/go_saas_test
```

The vitest global-setup forwards these as `DATABASE_URL` / `APP_DATABASE_URL` to the spawned Nuxt before boot. Migrations run once (idempotently) on first boot via the core layer's nitro plugin.

### Cleanup strategy (hybrid)

Per-layer prefixes + CASCADE FKs:

- **Core data**: `cleanupCoreTestData(sql)` deletes users matching `email LIKE 'test-core-%@example.com'` and the rate-limit rows whose `metadata->>ip` or `metadata->>email` carries the `test-` prefix. Cascade FKs (memberships → users, activity_logs.user_id, etc.) clean dependents.
- **Tenancy data**: `cleanupTenancyTestData(sql)` deletes orgs matching `slug LIKE 'test-tenancy-%'` (cascades wipe memberships, org_apps, role overrides) and tenancy-prefixed users.

Each test calls the appropriate cleanup in `afterEach`. The global-setup teardown closes the Postgres pool once at the end of the run — **per-file `afterAll(closeTestDatabases)` is wrong** (it kills the singleton mid-suite when other files still need it).

### NODE_ENV at build time

`@nuxt/test-utils` defaults the spawned Nuxt server to `NODE_ENV='test'`. The email layer's `isDevelopment` check is `=== 'development'` and is **inlined** into the bundle by Vite/Nitro at build time — so a `NODE_ENV='test'` build hardcodes `isDevelopment = false` forever, and emails attempt to go through real Mailgun.

The fix is in [dev/vitest.config.ts](../dev/vitest.config.ts) (`process.env.NODE_ENV = 'development'` at the top) and in each layer's `global-setup.ts` (`nuxtConfig.vite.define` + `nuxtConfig.nitro.replace` overrides). If you ever see "Failed to send verification email" in test output, this is what's broken.

### MailHog / Mailpit

The repo's email server is **Mailpit** (MailHog-compatible SMTP, but its own HTTP API). The test helper `waitForMailTo(email, timeoutMs?)` polls Mailpit's `/api/v1/messages` endpoint until a message addressed to `email` appears, then fetches the parsed body via `/api/v1/message/{id}`. `extractTokenFromBody(body, 'token')` regexes `?token=…` out of any URL in the body.

Override the URL with `TEST_MAILHOG_URL` if Mailpit isn't on the default `http://localhost:8025`.

### Public anonymous routes in multi-tenant mode

Pages that anonymous visitors must reach (public share links, embed-callback URLs, etc.) interact awkwardly with the tenancy layer's global route guard. The guard rewrites any non-system path to `/@<active-slug>/<path>` and bounces orgless visitors to `/orgs` → `/login`.

**The convention:**

- Generate share URLs in the org-scoped form: `${siteUrl}/@${activeSlug}/<path>/<token>`. The guard's `path.startsWith('/@')` early-return passes it through. The page's API call (e.g. `GET /api/videos/share/:token`) is what's actually public — the URL slug is a routing detail.
- Add the bare-path prefix to `SYSTEM_PREFIXES` in [layers/tenancy/app/middleware/tenant-route-guard.global.ts](../layers/tenancy/app/middleware/tenant-route-guard.global.ts) so legacy unprefixed URLs still in the wild keep resolving. The doubled `/@<slug>/<path>` form is added automatically by the tenancy `pages:extend` hook.
- Tests assert against the org-scoped URL. The vitest API tests cover the public endpoint contract (`GET /api/videos/share/:token`); the Playwright tests verify the anonymous browser flow against `/@<slug>/<path>/<token>` in a fresh `browser.newContext()` to avoid cookie bleed.

Live example: video share links. Generated by [layers/apps/videos/app/composables/useVideoUpload.ts](../layers/apps/videos/app/composables/useVideoUpload.ts) shareableLink computed; whitelisted in the route guard; covered by [tests/e2e/videos.spec.ts](../tests/e2e/videos.spec.ts) ("watch page renders a public video for an anonymous visitor").

## Writing a new test

API test for an existing endpoint:

```ts
// layers/<layer>/tests/<feature>/<endpoint>.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupTenancyTestData,
  createOperatorAdmin
} from '../helpers'

describe('POST /api/whatever', () => {
  const sql = getHostAdminDb()
  afterEach(async () => { await cleanupTenancyTestData(sql) })

  it('does the thing', async () => {
    const { auth } = await createOperatorAdmin(sql)
    const res = await $fetch('/api/whatever', {
      method: 'POST',
      body: { ... },
      ...auth
    })
    expect(res.id).toBeDefined()
  })
})
```

### Patterns to follow

- **Always seed via `getHostAdminDb()`** (BYPASSRLS). Direct INSERTs through `app_user` would be blocked by RLS for tenant tables.
- **Always assert via `$fetch`** (or the lower-level `fetch` from `@nuxt/test-utils/e2e` if you need to inspect headers / handle redirects manually). Don't reach into the DB to check what the handler "should have" done — read the response and *also* re-query the DB to confirm the side-effect landed.
- **Unique IPs for register tests**: pass `headers: { 'x-forwarded-for': testIp() }` (`testIp()` returns `test-${uuid}`) so the per-IP rate limit doesn't trip across tests. Cleanup wipes the matching activity_logs rows.
- **Email round-trips**: `clearMailhog()` in `beforeEach` if your test asserts a specific email. Then `waitForMailTo(email)` and `extractTokenFromBody(msg.body, 'token')`. Don't read tokens from the DB — exercising the email flow is the point.
- **Cross-org tests**: use `withOrgHeader(auth, slug)` to attach the `X-Active-Org` header. Member-vs-non-member is the canonical isolation test.
- **`fetch` for redirects + cookies**: `$fetch` parses the response body and follows redirects. When you need to assert on `Location` or `Set-Cookie`, use `fetch(path, { redirect: 'manual' })` from `@nuxt/test-utils/e2e` and check `res.status` / `res.headers.get(...)`.
- **Operator-admin endpoints in app layers** — use `withRecordOrgContext` from `#tenant/server` when the handler needs to read/write an RLS-protected table outside any tenant request context. App layers cannot import `#tenant/admin-db` (tenancy contract violation), so the helper is the sanctioned path: it resolves the row's `org_id` via adminDb internally, opens a `db` transaction, primes the `app.current_org` GUC, and runs the handler body. Pattern:

  ```ts
  import { requireOperatorAdmin, withRecordOrgContext } from '#tenant/server'

  export default defineEventHandler(async (event) => {
    await requireOperatorAdmin(event)
    const id = event.context.params?.id
    if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' })

    return await withRecordOrgContext(event, { table: 'cards', id }, async (tx) => {
      // tx is RLS-aware with the GUC set to this card's owning org.
      const card = await tx.selectFrom('cards').selectAll().where('id', '=', id).executeTakeFirst()
      // ...
    })
  })
  ```

  Without this, an `operator-admin` handler doing `db.selectFrom('cards')` outside a tenant context sees zero rows (RLS predicate false because the GUC is unset) and 404s on real data. Tests for these endpoints assert the *expected* 200/400/422 behaviour — if you see 404 on a real seeded row, the handler is missing the wrap.

### Patterns to avoid

- Don't add `afterAll(async () => { await closeTestDatabases() })` per-file. The global teardown handles it; per-file calls close the shared pool while other files still need it.
- Don't write tests that re-implement the function under test. If the only thing the test asserts is "the function returns what I'd return if I ran the same code," delete it. Test the *contract* (HTTP status, response shape, DB row, email sent), not the implementation.
- Don't share users / orgs across `it` blocks via top-level `beforeAll` seeds. Each test creates and asserts on its own data — order-independence is what makes the suite trustworthy.
- Don't use `bun test` to run vitest — it invokes Bun's own runner and skips the global setup. Always `bun run test`.

## Playwright

Playwright lives at the host level (one runner serves multi-layer flows). It self-starts Nuxt on `:2090` against the test DB via the `webServer` block in [dev/playwright.config.ts](../dev/playwright.config.ts).

### Serial, not parallel

The Playwright config sets `fullyParallel: false` and `workers: 1` — tests run one at a time. Two shared resources force this:

- **Mailpit's inbox is a single global queue.** Parallel workers calling `clearMailhog()` wipe each other's pending verification messages; `waitForMailTo(email)` then times out on a message that never arrives because some other worker already polled it.
- **Postgres is shared.** Per-test seeds are unique-prefixed, but parallel runs still race on `cleanupTenancyTestData` running in another worker mid-test.

The serial run is ~30s total. If that climbs above ~2 minutes we can revisit (sharded Mailpit + isolated test DB per worker), but it's not worth the complexity yet.

### Smoke vs. helper-injected auth

There's exactly **one** UI-driven smoke test ([tests/e2e/smoke/register-login.spec.ts](../tests/e2e/smoke/register-login.spec.ts)) that goes through the actual register → email-verify → login flow. Every other browser test should use [tests/e2e/helpers/login.ts](../tests/e2e/helpers/login.ts):

```ts
import { test, expect } from '@playwright/test'
import { loginAsNewUser, loginIntoNewOrg, loginIntoMultipleOrgs } from './helpers/login'

test('non-org action', async ({ page }) => {
  await loginAsNewUser(page, { is_admin: true })
  await page.goto('/admin/orgs')
})

test('org-scoped action', async ({ page }) => {
  const { org } = await loginIntoNewOrg(page, { roles: ['admin'] })
  await page.goto(`/@${org.slug}/settings/apps`)
})
```

The helpers mint a JWT and inject the cookie via `page.context().addCookies([{ name, value, url, httpOnly: true }])` — the `url` form is more reliable than `domain+path` for httpOnly cookies on localhost.

### Patterns for browser tests

- **Wait for the API response, not just the URL.** Forms that do `await $fetch(...); await navigateTo(...)` (or worse, `setTimeout(() => router.push(...), 2000)`) introduce timing gaps. Don't assert `toHaveURL(...)` immediately after a click — wrap the click in `Promise.all([page.waitForResponse(r => r.url().includes('/api/...') && r.status() === 200), click])` first. This is what fixes "stayed on /login" flakes.

  ```ts
  await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/auth/login') && r.status() === 200),
    page.click('button[type="submit"]')
  ])
  await expect(page).not.toHaveURL(/\/login/)
  ```

- **Fresh browser context for invite-acceptance flows.** When testing "user A invites user B, B accepts", use `page.context().browser()!.newContext()` for B so A's auth cookie doesn't bleed into B's session. Remember to close the context (`await inviteeContext.close()`).

- **Form fills + clicks** wait for the element automatically — no `waitForSelector` needed before `page.fill(...)` or `page.click(...)`.

- **Trust selectors by role + accessible name** (`page.getByRole('button', { name: /invite member/i })`) over CSS selectors when the button has a readable label. Survives styling refactors.

- **Hide bottom-right fixed widgets** when the page under test renders modals/slideovers near that area. The feedback chat-bubble widget (FEEDBACK_PROJECT_ID env) sits at `position: fixed; bottom: 20px; right: 20px` on every page; even when stacked below Reka's modal layer it can capture clicks on slideover action buttons in headless Chromium. Hide it in `test.beforeEach` with `page.addInitScript(...)` — see [tests/e2e/feedback.spec.ts](../tests/e2e/feedback.spec.ts) for the canonical pattern (`.feedback-widget-slot { display: none !important }`). Only needed when the spec drives slideovers/modals whose buttons land in the bottom-right corner.

## Coverage standard: every layer ships both

Every layer — base (core, tenancy) and app (`messages`, `kanban`, `videos`, `feedback`, `calendar`, `list-of-100`, plus anything future) — ships **both** vitest API tests AND Playwright UI tests. One without the other is incomplete coverage:

- **Vitest** catches handler logic: HTTP contract, validation, permission gates, RLS, DB state changes, hooks fired, emails sent. Fast, exhaustive, easy to write.
- **Playwright** catches the wiring: router redirects, cookie/middleware behavior, modal dismiss, form validation, real-time list updates, navigation between routes, layout integration. Slow, expensive per test, irreplaceable.

### Vitest expectations (per layer)

Cover every endpoint. For each endpoint, at least:

- Happy path with the right permissions
- 401 unauthenticated (where applicable)
- 403 for a user without the required permission
- 400 for malformed input
- 404 / 409 for not-found / conflict edge cases the endpoint explicitly handles
- RLS isolation (a non-member of orgA cannot see orgA's data)
- Side effects: DB row landed, hook fired, email queued in Mailpit if applicable

### Playwright expectations (per layer)

Pick **5–8 marquee flows** per layer — the user journeys that would embarrass the project if they broke. Heuristics for what makes the cut:

- **Main actions**: compose/send, create/edit/delete the primary resource, the buttons users click 100× a day
- **Cross-route navigation**: clicking from list → detail, detail → settings, settings → back-to-list
- **Multi-user interactions**: A acts, B sees the result (mentions, comments, reactions, shared cards)
- **Permission-gated UI**: a button visible to admins is hidden from members
- **Negative paths the chrome handles**: 404 / 423 / 403 render the right UI, not raw errors

Skip if it's too fragile to drive reliably (e.g. emoji pickers, drag-and-drop on some libraries) — note the gap in the spec file's header comment and pin it for a follow-up.

### Sequencing when adding a new layer

Add tests for a new layer in this order:

1. Inventory the layer's API endpoints + UI pages
2. Write vitest tests for the API (helpers, global-setup, register `layerProject(...)` in `dev/vitest.config.ts`)
3. Get vitest green for the layer (`bun run test --project=<layer>`)
4. Write Playwright spec at `tests/e2e/<layer>.spec.ts` covering the marquee flows
5. Run `bun run test:e2e` twice in a row to catch flakes
6. Run the full suite (`bun run test && bun run test:e2e`) before declaring done — your layer must not regress others

When adding multiple layers via background subagents, **dispatch serially**: every agent edits `dev/vitest.config.ts` to add its `layerProject(...)` entry, and parallel agents will race on that file. Wait for each to complete + verify before launching the next.

## Test database lifecycle

```
scripts/setup-test-db.sh                 → CREATE ROLE host_admin / app_user; CREATE DATABASE go_saas_test
                                            (idempotent; safe to re-run anytime)

bun run test
  ↓
dev/scripts/run-tests.mjs               → spawns vitest with verbose + json reporters
  ↓
vitest loads dev/vitest.config.ts       → pins NODE_ENV='development' before build
  ↓
each layer project's global-setup.ts     → @nuxt/test-utils starts Nuxt server
                                            with DATABASE_URL=TEST_DATABASE_URL
                                            with APP_DATABASE_URL=TEST_APP_DATABASE_URL
  ↓
nitro plugin runs migrations (idempotent on host_admin connection)
  ↓
each test file's beforeEach/afterEach    → seeds + cleans its own data
                                            via getHostAdminDb() (BYPASSRLS)
  ↓
global teardown                          → closeTestDatabases() once at end
```

If migrations get out of sync (rare — usually a renamed migration file):

```bash
psql -U postgres -c 'DROP DATABASE go_saas_test'
bun run test:db                                          # recreates
```

If the host's `.nuxt/` directory accumulates stale generated imports (you'll see `ERR_MODULE_NOT_FOUND` for files you've deleted), the test command always runs `nuxt prepare` first, which regenerates them. If you've deleted a plugin file mid-test-run, just re-run `bun run test`.

## CI

Not yet wired. When it is, the GitHub Actions workflow needs:

- Postgres service container (or `services: postgres`) — the workflow runs `setup-test-db.sh` to provision the roles + DB
- Mailpit service container (or skip email tests on CI by tagging them and filtering)
- `bun install`, `bun run test:db`, `bun run test`, `bun playwright install chromium`, `bun run test:e2e`

The wrapper script's plain-text summary will show in CI logs without ANSI noise.

## Out of scope for the test rig

- Component-level Vue tests (`@vue/test-utils`). Defer until a component is genuinely complex enough that an isolated test pays for itself.
- Visual regression (Percy / Chromatic).
- Load / performance testing (k6, Artillery).
- Mutation testing.
- Pure-function unit tests for trivial helpers (slug parsing, etc.) — only worth writing when the function is genuinely tricky and the test isn't tautological.
