// Save-time embedding: every section save chunks and embeds through the AI
// fake, a failed embed leaves the save intact and the section stale, and the
// reindex route clears it.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupContextTestData,
  createContextOrgWith,
  createTestPortfolio,
  withOrgHeader,
  resetAiFake,
  getAiFakeLog,
  getAppUserDb
} from '../helpers'

interface SectionRead {
  content: string
  index_state: 'none' | 'ok' | 'stale'
  index_error: string | null
}

describe('section vector index', () => {
  const sql = getHostAdminDb()
  beforeEach(async () => {
    await resetAiFake()
  })
  afterEach(async () => {
    await cleanupContextTestData(sql)
    await resetAiFake()
  })

  async function setup() {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const p = await createTestPortfolio(sql, { org_id: org.id, name: 'Indexed', created_by: user.id })
    return { org, p, opts: withOrgHeader(auth, org.slug) }
  }

  it('embeds on save and stores one chunk row per chunk with the model id', async () => {
    const { p, opts } = await setup()
    const res = await $fetch<{ id: string }>(`/api/context/portfolios/${p.slug}/sections/identity`, {
      method: 'PUT', body: { content: '# Who we are\n\nAcme makes anvils.\n\n## Where\n\nWe are in Springfield.' }, ...opts
    })
    const chunks = await sql<{ ordinal: number, heading: string, model: string, content: string }[]>`
      SELECT ordinal, heading, model, content FROM context_section_chunks WHERE section_id = ${res.id} ORDER BY ordinal
    `
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks[0]!.model).toBe('test/embed-small')
    expect(chunks.map(c => c.content).join('\n')).toContain('Acme makes anvils.')

    const read = await $fetch<SectionRead>(`/api/context/portfolios/${p.slug}/sections/identity`, { ...opts })
    expect(read.index_state).toBe('ok')
    expect(read.index_error).toBeNull()

    const embeds = (await getAiFakeLog()).filter(c => c.kind === 'embed')
    expect(embeds.length).toBe(1)
  })

  it('replaces chunks on the next save', async () => {
    const { p, opts } = await setup()
    const first = await $fetch<{ id: string }>(`/api/context/portfolios/${p.slug}/sections/identity`, {
      method: 'PUT', body: { content: 'Version one.' }, ...opts
    })
    await $fetch(`/api/context/portfolios/${p.slug}/sections/identity`, { method: 'PUT', body: { content: 'Version two.' }, ...opts })
    const chunks = await sql<{ content: string }[]>`SELECT content FROM context_section_chunks WHERE section_id = ${first.id}`
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.content).toContain('Version two.')
  })

  it('keeps the save when embedding fails, marks the section stale, and reindex clears it', async () => {
    const { p, opts } = await setup()
    // The fake throws for any input containing [[fail]].
    const res = await $fetch<{ id: string, content: string }>(`/api/context/portfolios/${p.slug}/sections/identity`, {
      method: 'PUT', body: { content: 'This will [[fail]] to embed.' }, ...opts
    })
    expect(res.content).toBe('This will [[fail]] to embed.')
    let read = await $fetch<SectionRead>(`/api/context/portfolios/${p.slug}/sections/identity`, { ...opts })
    expect(read.index_state).toBe('stale')
    expect(read.index_error).toBeTruthy()

    // Fix the content, but through the reindex route rather than a save: it
    // must re-embed the stored content. First a save that succeeds…
    await $fetch(`/api/context/portfolios/${p.slug}/sections/identity`, { method: 'PUT', body: { content: 'Now fine.' }, ...opts })
    read = await $fetch<SectionRead>(`/api/context/portfolios/${p.slug}/sections/identity`, { ...opts })
    expect(read.index_state).toBe('ok')

    // …then simulate a stale flag and clear it with the route.
    await sql`UPDATE context_sections SET index_state = 'stale', index_error = 'boom' WHERE id = ${res.id}`
    const out = await $fetch<{ index_state: string, chunks: number }>(`/api/context/portfolios/${p.slug}/sections/identity/reindex`, { method: 'POST', ...opts })
    expect(out.index_state).toBe('ok')
    expect(out.chunks).toBe(1)
  })

  it('embeds after the save commits, holding no transaction during the call', async () => {
    const { p, opts } = await setup()
    await $fetch('/api/_test/ai', { method: 'POST', body: { embedDelayMs: 1500 } })
    const save = $fetch<{ id: string }>(`/api/context/portfolios/${p.slug}/sections/identity`, {
      method: 'PUT', body: { content: 'Slow to embed.' }, ...opts
    })
    await new Promise(r => setTimeout(r, 1000))
    // As app_user: pg_stat_activity hides other roles' session state.
    const open = await getAppUserDb()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE state LIKE 'idle in transaction%' AND now() - xact_start > interval '400 milliseconds'
    `
    expect(open[0]!.n).toBe(0)
    // The content is committed before the embed finishes…
    const [mid] = await sql<{ content: string }[]>`SELECT content FROM context_sections WHERE portfolio_id = ${p.id} AND section_key = 'identity'`
    expect(mid!.content).toBe('Slow to embed.')
    // …and the response still waits for the index.
    const res = await save
    const chunks = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM context_section_chunks WHERE section_id = ${res.id}`
    expect(chunks[0]!.n).toBe(1)
  })

  it('cascades chunks when the section goes', async () => {
    const { p, opts } = await setup()
    const res = await $fetch<{ id: string }>(`/api/context/portfolios/${p.slug}/sections/identity`, {
      method: 'PUT', body: { content: 'Gone soon.' }, ...opts
    })
    await sql`DELETE FROM context_sections WHERE id = ${res.id}`
    const chunks = await sql<{ id: string }[]>`SELECT id FROM context_section_chunks WHERE section_id = ${res.id}`
    expect(chunks).toHaveLength(0)
  })

  it('an org re-embed reports each section as it goes and ends with items equal to the total', async () => {
    const { p, opts } = await setup()
    for (const key of ['identity', 'team']) {
      await $fetch(`/api/context/portfolios/${p.slug}/sections/${key}`, { method: 'PUT', body: { content: `Content for ${key}.` }, ...opts })
    }
    // Another org's sections must stay out of this org's re-embed.
    const other = await setup()
    await $fetch(`/api/context/portfolios/${other.p.slug}/sections/identity`, { method: 'PUT', body: { content: 'Other org content.' }, ...other.opts })
    const [otherBefore] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM context_section_chunks WHERE portfolio_id = ${other.p.id}
    `
    // A re-embed runs only when a model resolves for the org.
    await $fetch('/api/ai/org/config', { method: 'PUT', body: { embedding_model: 'test/embed-small' }, ...opts })
    const start = await $fetch<{ started: boolean }>('/api/ai/org/reindex', { method: 'POST', ...opts })
    expect(start.started).toBe(true)
    type Scope = { state: string, items: number, total: number, chunks: number, current: string | null }
    let scope: Scope | undefined
    for (let i = 0; i < 100; i++) {
      const status = await $fetch<{ running: boolean, scopes: Scope[] }>('/api/ai/org/reindex-status', { ...opts })
      scope = status.scopes[0]
      if (!status.running) break
      await new Promise(r => setTimeout(r, 100))
    }
    expect(scope!.state).toBe('done')
    expect(scope!.current).toBeNull()
    // Every built-in section of the portfolio counts, written or not.
    const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM context_sections WHERE portfolio_id = ${p.id}`
    expect(scope!.total).toBe(row!.n)
    expect(scope!.total).toBeGreaterThan(0)
    expect(scope!.items).toBe(scope!.total)
    expect(scope!.chunks).toBeGreaterThanOrEqual(2)
    const leaked = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM context_section_chunks WHERE portfolio_id = ${other.p.id} AND org_id <> ${other.org.id}
    `
    expect(leaked[0]!.n).toBe(0)
    const [otherAfter] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM context_section_chunks WHERE portfolio_id = ${other.p.id}
    `
    expect(otherAfter!.n).toBe(otherBefore!.n)
  })

  it('an org re-embed holds no transaction across embedding calls', async () => {
    const { p, opts } = await setup()
    for (const key of ['identity', 'team']) {
      await $fetch(`/api/context/portfolios/${p.slug}/sections/${key}`, { method: 'PUT', body: { content: `Content for ${key}.` }, ...opts })
    }
    await $fetch('/api/ai/org/config', { method: 'PUT', body: { embedding_model: 'test/embed-small' }, ...opts })
    await $fetch('/api/_test/ai', { method: 'POST', body: { embedDelayMs: 1000 } })
    await $fetch('/api/ai/org/reindex', { method: 'POST', ...opts })
    await new Promise(r => setTimeout(r, 1500))
    const open = await getAppUserDb()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE state LIKE 'idle in transaction%' AND now() - xact_start > interval '400 milliseconds'
    `
    expect(open[0]!.n).toBe(0)
    for (let i = 0; i < 200; i++) {
      const status = await $fetch<{ running: boolean }>('/api/ai/org/reindex-status', { ...opts })
      if (!status.running) break
      await new Promise(r => setTimeout(r, 100))
    }
  })

  it('a section with content but no chunks reads as unindexed and makes the org index stale', async () => {
    const { p, opts } = await setup()
    await $fetch('/api/ai/org/config', { method: 'PUT', body: { embedding_model: 'test/embed-small' }, ...opts })
    // Written before embeddings existed: content, no chunks, state 'none'.
    await sql`
      INSERT INTO context_sections (portfolio_id, section_key, content, index_state)
      VALUES (${p.id}, 'identity', 'Old content.', 'none')
      ON CONFLICT (portfolio_id, section_key) DO UPDATE SET content = 'Old content.', index_state = 'none'
    `
    await sql`DELETE FROM context_section_chunks WHERE portfolio_id = ${p.id}`
    const read = await $fetch<{ index_state: string }>(`/api/context/portfolios/${p.slug}/sections/identity`, { ...opts })
    expect(read.index_state).toBe('unindexed')
    const cfg = await $fetch<{ embeddingStale: boolean }>('/api/ai/org/config', { ...opts })
    expect(cfg.embeddingStale).toBe(true)

    const out = await $fetch<{ index_state: string }>(`/api/context/portfolios/${p.slug}/sections/identity/reindex`, { method: 'POST', ...opts })
    expect(out.index_state).toBe('ok')
  })
})
