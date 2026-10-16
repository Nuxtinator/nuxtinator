// Helpinator test helpers. Re-exports tenancy + core helpers and adds: an org
// with the helpinator/context/inbox apps enabled, portfolio + section seeding,
// widget seeding, the AI fake, and cleanup.
//
// Everything is tagged `test-helpinator-` (users, org slugs) so cleanup stays
// scoped; helpinator, context and inbox rows cascade off the test orgs.
import type postgres from 'postgres'
import { createHash, randomUUID } from 'node:crypto'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getAppUserDb,
  createTestUser,
  getAuthHeaders,
  withOrgHeader,
  type AuthHeaders,
  type TestUser,
  createTestOrg,
  addTestMembership,
  type TestOrg
} from '@nuxtinator/tenancy/test-helpers'

export * from '@nuxtinator/tenancy/test-helpers'
export * from './fixture-site'

// An origin allowed on seeded widgets. Not loopback, so origin checks bite.
export const SITE_ORIGIN = 'https://help-site.example'

export async function createHelpinatorUser(sql: ReturnType<typeof postgres>): Promise<TestUser> {
  return createTestUser(sql, { email: `test-helpinator-${randomUUID().slice(0, 8)}@example.com` })
}

export async function createHelpinatorOrgWith(
  sql: ReturnType<typeof postgres>,
  roles: string[] = ['admin']
): Promise<{ org: TestOrg, user: TestUser, auth: AuthHeaders, opts: ReturnType<typeof withOrgHeader> }> {
  const user = await createHelpinatorUser(sql)
  const org = await createTestOrg(sql, { slug: `test-helpinator-${randomUUID().slice(0, 8)}`, name: 'Test Helpinator Org' })
  await addTestMembership(sql, { user_id: user.id, org_id: org.id, roles })
  for (const app of ['helpinator', 'context', 'inbox', 'crm']) {
    await sql`INSERT INTO apps (id, status) VALUES (${app}, 'available') ON CONFLICT (id) DO NOTHING`
    await sql`
      INSERT INTO org_apps (org_id, app_id, enabled, source)
      VALUES (${org.id}, ${app}, true, 'org_admin')
      ON CONFLICT DO NOTHING
    `
  }
  return { org, user, auth: getAuthHeaders(user), opts: withOrgHeader(getAuthHeaders(user), org.slug) }
}

export async function addHelpinatorMember(
  sql: ReturnType<typeof postgres>,
  org: TestOrg,
  roles: string[] = ['member']
): Promise<{ user: TestUser, opts: ReturnType<typeof withOrgHeader> }> {
  const user = await createHelpinatorUser(sql)
  await addTestMembership(sql, { user_id: user.id, org_id: org.id, roles })
  return { user, opts: withOrgHeader(getAuthHeaders(user), org.slug) }
}

// The ai layer's VITEST embedding (ai-test-fake.ts aiFakeEmbedVector), copied
// here so seeded sections get chunks the booted host's fake will match: each
// word hashes to four dimensions of a 1536-wide bag-of-words vector, unit
// normalised. If the fake changes, the section-hit tests below stop matching.
export const FAKE_EMBED_DIMENSIONS = 1536
export function fakeEmbedVector(text: string): number[] {
  const v = new Array<number>(FAKE_EMBED_DIMENSIONS).fill(0)
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  for (const w of words) {
    const h = createHash('sha256').update(w).digest()
    for (let i = 0; i < 4; i++) {
      const idx = h.readUInt16BE(i * 2) % FAKE_EMBED_DIMENSIONS
      v[idx] = v[idx]! + 1
    }
  }
  const norm = Math.sqrt(v.reduce((s, n) => s + n * n, 0)) || 1
  return v.map(n => n / norm)
}

// A portfolio with the given sections (key → content), each indexed as one
// chunk the way the context layer's save hook would (title + content). Custom
// section definitions carry their own titles, so no catalog dependency.
export async function seedPortfolio(
  sql: ReturnType<typeof postgres>,
  orgId: string,
  name: string,
  sections: Record<string, string>
): Promise<{ id: string, slug: string }> {
  const id = randomUUID()
  const slug = `test-helpinator-${randomUUID().slice(0, 8)}`
  await sql`INSERT INTO context_portfolios (id, slug, name, org_id) VALUES (${id}, ${slug}, ${name}, ${orgId})`
  for (const [key, content] of Object.entries(sections)) {
    await sql`
      INSERT INTO context_section_definitions (portfolio_id, key, title, description)
      VALUES (${id}, ${key}, ${`Title ${key}`}, '')
    `
    const [section] = await sql<{ id: string }[]>`
      INSERT INTO context_sections (portfolio_id, section_key, content, index_state)
      VALUES (${id}, ${key}, ${content}, 'ok')
      RETURNING id
    `
    const text = `Title ${key}\n\n${content}`
    const vector = `[${fakeEmbedVector(text).join(',')}]`
    await sql`
      INSERT INTO context_section_chunks (section_id, portfolio_id, ordinal, heading, content, embedding, model, org_id)
      VALUES (${section!.id}, ${id}, 0, '', ${text}, ${vector}::vector, 'test/embed-small', ${orgId})
    `
  }
  return { id, slug }
}

// A library: a pointer at a portfolio, or an empty website library to crawl.
export async function seedLibrary(
  sql: ReturnType<typeof postgres>,
  opts: { orgId: string, name?: string, kind?: 'website' | 'portfolio', portfolioId?: string | null }
): Promise<{ id: string }> {
  const id = randomUUID()
  const kind = opts.kind ?? (opts.portfolioId ? 'portfolio' : 'website')
  await sql`
    INSERT INTO helpinator_libraries (id, name, kind, portfolio_id, org_id)
    VALUES (${id}, ${opts.name ?? `Test ${kind} library`}, ${kind}, ${opts.portfolioId ?? null}, ${opts.orgId})
  `
  return { id }
}

// A widget on one or more libraries. The common case — one portfolio — takes
// `portfolioId` + `sectionKey` and seeds the library too.
export async function seedWidget(
  sql: ReturnType<typeof postgres>,
  opts: {
    orgId: string
    portfolioId?: string
    sectionKey?: string | null
    libraryIds?: string[]
    defaultLibraryId?: string
    origins?: string[]
    cap?: number
    enabled?: boolean
  }
): Promise<{ id: string, libraryId: string }> {
  let libraryIds = opts.libraryIds ?? []
  if (opts.portfolioId) {
    const lib = await seedLibrary(sql, { orgId: opts.orgId, portfolioId: opts.portfolioId })
    libraryIds = [lib.id, ...libraryIds]
  }
  const defaultLibraryId = opts.defaultLibraryId ?? libraryIds[0]!
  const id = randomUUID()
  await sql`
    INSERT INTO helpinator_widgets (id, name, library_ids, default_library_id, default_section_key, allowed_origins, daily_message_cap, enabled, org_id)
    VALUES (${id}, 'Test widget', ${libraryIds}::uuid[], ${defaultLibraryId}, ${opts.sectionKey ?? null}, ${opts.origins ?? [SITE_ORIGIN]},
            ${opts.cap ?? 500}, ${opts.enabled ?? true}, ${opts.orgId})
  `
  return { id, libraryId: defaultLibraryId }
}

// --- Public widget calls ----------------------------------------------------

export function widgetHeaders(token?: string | null, origin = SITE_ORIGIN): Record<string, string> {
  return { origin, ...(token ? { authorization: `Bearer ${token}` } : {}) }
}

export interface TurnResult {
  token: string
  conversationId: string
  reset: boolean
  userMessage: { id: string, content: string }
  assistantMessage: { id: string, content: string }
}

export async function sendTurn(widgetId: string, message: string, token?: string | null, origin?: string): Promise<TurnResult> {
  return await $fetch<TurnResult>(`/api/v1/helpinator/widgets/${widgetId}/messages`, {
    method: 'POST',
    headers: widgetHeaders(token, origin),
    body: { message, pageUrl: `${SITE_ORIGIN}/pricing` }
  })
}

// --- The AI fake --------------------------------------------------------------

export interface AiFakeCall {
  kind: 'complete' | 'generate' | 'embed'
  model: string
  system: unknown
  messages: Array<{ role: string, content: unknown }>
  tools: string[]
  toolResults: Array<{ name: string, input: Record<string, unknown>, result: string }>
}

export async function primeAiFake(script: { text?: string, toolCalls?: Array<{ name: string, input: Record<string, unknown> }>, delayMs?: number, embedDelayMs?: number, failWith?: number }): Promise<void> {
  await $fetch('/api/_test/ai', { method: 'POST', body: script })
}

export async function getAiFakeLog(): Promise<AiFakeCall[]> {
  return await $fetch<AiFakeCall[]>('/api/_test/ai')
}

export async function resetAiFake(): Promise<void> {
  await $fetch('/api/_test/ai', { method: 'DELETE' })
}

export function systemText(call: { system?: unknown }): string {
  const s = call.system
  if (typeof s === 'string') return s
  return Array.isArray(s) ? s.map(p => String((p as { text?: string }).text ?? '')).join('') : ''
}

export async function cleanupHelpinatorTestData(sql: ReturnType<typeof postgres>): Promise<void> {
  // Every test shares one client IP; reset the widget rate-limit windows.
  await sql`DELETE FROM activity_logs WHERE event_type LIKE 'ratelimit.helpinator%'`
  // Helpinator, context and inbox rows cascade off the org (tenancy retrofits).
  await sql`DELETE FROM orgs WHERE slug LIKE 'test-helpinator-%'`
  await sql`DELETE FROM users WHERE email LIKE 'test-helpinator-%@example.com'`
}

// --- Libraries over the admin API -------------------------------------------

export interface LibraryDetail {
  id: string
  name: string
  kind: 'website' | 'portfolio'
  sources: Array<{ id: string, url: string, status: string, page_count: number, max_page_mb: number, last_error: string | null }>
  stats: { pages: number, chunks: number, bytes: number, models: string[] }
  index_stale: boolean
}

export async function createWebsiteLibrary(opts: object, name = 'Site'): Promise<{ id: string }> {
  return await $fetch<{ id: string }>('/api/helpinator/libraries', { method: 'POST', body: { name, kind: 'website' }, ...opts })
}

export async function addSource(opts: object, libraryId: string, url: string, extra: Record<string, unknown> = {}): Promise<{ id: string, status: string }> {
  return await $fetch<{ id: string, status: string }>(`/api/helpinator/libraries/${libraryId}/sources`, { method: 'POST', body: { url, ...extra }, ...opts })
}

export async function getLibrary(opts: object, libraryId: string): Promise<LibraryDetail> {
  return await $fetch<LibraryDetail>(`/api/helpinator/libraries/${libraryId}`, { ...opts })
}

// Poll until no source of the library is syncing.
export async function waitForSync(opts: object, libraryId: string, timeoutMs = 30_000): Promise<LibraryDetail> {
  const start = Date.now()
  for (;;) {
    const lib = await getLibrary(opts, libraryId)
    if (!lib.sources.some(s => s.status === 'syncing')) return lib
    if (Date.now() - start > timeoutMs) throw new Error(`sync of ${libraryId} did not finish in ${timeoutMs}ms`)
    await new Promise(r => setTimeout(r, 300))
  }
}

// Transactions the server (app_user) has held open for more than `ms`. Read
// as app_user: pg_stat_activity hides other roles' session state.
export async function longOpenTransactions(ms = 400): Promise<number> {
  const rows = await getAppUserDb()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE state LIKE 'idle in transaction%' AND now() - xact_start > ${`${ms} milliseconds`}::interval
  `
  return rows[0]!.n
}
