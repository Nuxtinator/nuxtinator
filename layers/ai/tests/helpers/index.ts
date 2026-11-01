// AI-layer test helpers. Re-exports tenancy + core helpers and adds an
// operator-admin-in-a-fresh-org bootstrap (the host AI endpoints gate on
// requireOperatorAdmin; the org gives the caller an ordinary tenant context),
// a plain-member bootstrap for the org.settings.write gate, and prefix-scoped
// cleanup.
//
// All seeded data is prefixed `test-ai-` (users, org slugs) so cleanup stays
// scoped. Host config is deployment-global (`core_host_settings`, namespace
// `ai`) and shared by every test, so suites clear it between tests.
import type postgres from 'postgres'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  createTestUser,
  getAuthHeaders,
  withOrgHeader,
  createTestOrg,
  addTestMembership,
  type AuthHeaders,
  type TestUser,
  type TestOrg
} from '@nuxtinator/tenancy/test-helpers'

export * from '@nuxtinator/tenancy/test-helpers'

// The ids of the fixed model list the booted host serves under VITEST
// (server/utils/ai-model-list.ts AI_TEST_MODELS): the chat models alpha, beta,
// gamma, one transcription model and one decision model.
export const AI_TEST_MODEL_IDS = ['test/alpha', 'test/beta', 'test/gamma'] as const
export const AI_TEST_TRANSCRIPTION_MODEL_ID = 'test/whisper'
export const AI_TEST_DECISION_MODEL_ID = 'test/decider'

// An operator-admin user (users.is_admin) in a fresh org with membership, plus
// X-Active-Org opts so calls look like normal in-org traffic. Pass
// `{ admin: false }` for a non-operator user to assert the 403 gate.
export async function createAiOrg(
  sql: ReturnType<typeof postgres>,
  { admin = true }: { admin?: boolean } = {}
): Promise<{ org: TestOrg, user: TestUser, auth: AuthHeaders, opts: ReturnType<typeof withOrgHeader> }> {
  const user = await createTestUser(sql, {
    email: `test-ai-${randomUUID().slice(0, 8)}@example.com`,
    is_admin: admin
  })
  const org = await createTestOrg(sql, {
    slug: `test-ai-${randomUUID().slice(0, 8)}`,
    name: 'Test AI Org'
  })
  await addTestMembership(sql, { user_id: user.id, org_id: org.id, roles: ['admin'] })

  const auth = getAuthHeaders(user)
  return { org, user, auth, opts: withOrgHeader(auth, org.slug) }
}

// A plain member of an existing org (no org.settings.* permissions).
export async function createAiOrgMember(
  sql: ReturnType<typeof postgres>,
  org: TestOrg
): Promise<{ user: TestUser, auth: AuthHeaders, opts: ReturnType<typeof withOrgHeader> }> {
  const user = await createTestUser(sql, {
    email: `test-ai-${randomUUID().slice(0, 8)}@example.com`,
    is_admin: false
  })
  await addTestMembership(sql, { user_id: user.id, org_id: org.id, roles: ['member'] })
  const auth = getAuthHeaders(user)
  return { user, auth, opts: withOrgHeader(auth, org.slug) }
}

export async function clearAiHostConfig(sql: ReturnType<typeof postgres>): Promise<void> {
  await sql`DELETE FROM core_host_settings WHERE namespace = 'ai'`
}

export async function cleanupAiTestData(sql: ReturnType<typeof postgres>): Promise<void> {
  await clearAiHostConfig(sql)
  await sql`DELETE FROM core_settings WHERE namespace = 'ai' AND org_id IN (SELECT id FROM orgs WHERE slug LIKE 'test-ai-%')`
  await sql`DELETE FROM activity_logs WHERE org_id IN (SELECT id FROM orgs WHERE slug LIKE 'test-ai-%')`
  await sql`DELETE FROM ai_usage WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'test-ai-%')`
  await sql`DELETE FROM orgs WHERE slug LIKE 'test-ai-%'`
  await sql`DELETE FROM users WHERE email LIKE 'test-ai-%'`
}

// --- The AI fake (VITEST network stand-in) ---
//
// The booted host routes every `complete()` / `generate()` to a primeable fake
// (server/utils/ai-test-fake.ts). These helpers drive it over its control
// endpoint so a consumer-layer suite can script the model's next answer and
// assert what it was asked.

export interface AiFakeScript {
  text?: string
  toolCalls?: Array<{ name: string, input: Record<string, unknown> }>
  generateInput?: Record<string, unknown>
  decisions?: Record<string, Record<string, unknown>>
}

export interface AiFakeCall {
  kind: 'complete' | 'generate' | 'embed' | 'transcribe' | 'decide'
  model: string
  system: unknown
  messages: Array<{ role: string, content: unknown }>
  tools: string[]
  toolResults: Array<{ name: string, input: Record<string, unknown>, result: string }>
  decision?: { input: unknown, questions: Record<string, Record<string, unknown>> }
}

export async function primeAiFake(script: AiFakeScript): Promise<void> {
  await $fetch('/api/_test/ai', { method: 'POST', body: script })
}

export async function getAiFakeLog(): Promise<AiFakeCall[]> {
  return await $fetch<AiFakeCall[]>('/api/_test/ai')
}

export async function resetAiFake(): Promise<void> {
  await $fetch('/api/_test/ai', { method: 'DELETE' })
}
