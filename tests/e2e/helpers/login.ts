// Playwright auth + org helpers. Each test gets its own user (and optionally
// org + membership) seeded via SQL; the JWT is minted and dropped into the
// browser context as a cookie. No UI logins for setup, no shared session.
import type { Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  createTestUser,
  generateTestToken,
  type TestUser
} from '@nuxtinator/core/test-helpers'
import {
  createTestOrg,
  addTestMembership,
  createTenancyUser,
  type TestOrg
} from '@nuxtinator/tenancy/test-helpers'

function setAuthCookie(page: Page, token: string): Promise<void> {
  // The `url` form is more reliable than domain+path for httpOnly cookies on
  // localhost — Playwright derives the right domain/path/secure from the URL.
  const baseURL = page.context()._options?.baseURL || process.env.TEST_BASE_URL || 'http://localhost:2090'
  return page.context().addCookies([{
    name: 'auth-token',
    value: token,
    url: baseURL,
    httpOnly: true,
    sameSite: 'Lax'
  }])
}

// Create a fresh user (no orgs, just an authenticated identity).
export async function loginAsNewUser(
  page: Page,
  opts: Parameters<typeof createTestUser>[1] = {}
): Promise<TestUser> {
  const sql = getHostAdminDb()
  const user = await createTestUser(sql, opts)
  await setAuthCookie(page, generateTestToken(user))
  return user
}

// Create a fresh user, a fresh org, the membership row tying them, and log
// the user in. The most common shape for browser tests that exercise org-
// scoped UI.
export async function loginIntoNewOrg(
  page: Page,
  opts: { roles?: string[], userOpts?: Parameters<typeof createTestUser>[1], orgOpts?: { slug?: string, name?: string } } = {}
): Promise<{ user: TestUser, org: TestOrg }> {
  const sql = getHostAdminDb()
  const user = await createTenancyUser(sql, opts.userOpts)
  const org = await createTestOrg(sql, opts.orgOpts)
  await addTestMembership(sql, {
    user_id: user.id,
    org_id: org.id,
    roles: opts.roles ?? ['admin']
  })
  await setAuthCookie(page, generateTestToken(user))
  return { user, org }
}

// Create N orgs and add the user as a member of each. Useful for org-switcher
// tests that need a user with multiple memberships.
export async function loginIntoMultipleOrgs(
  page: Page,
  count: number,
  opts: { roles?: string[] } = {}
): Promise<{ user: TestUser, orgs: TestOrg[] }> {
  const sql = getHostAdminDb()
  const user = await createTenancyUser(sql)
  const orgs: TestOrg[] = []
  for (let i = 0; i < count; i++) {
    const org = await createTestOrg(sql, { name: `Multi-${i}-${randomUUID().slice(0, 6)}` })
    await addTestMembership(sql, { user_id: user.id, org_id: org.id, roles: opts.roles ?? ['admin'] })
    orgs.push(org)
  }
  await setAuthCookie(page, generateTestToken(user))
  return { user, orgs }
}
