// The assistant's vector search: hits for the user's message are injected as a
// second system part on every turn, the search_sections tool returns only
// sections of the portfolios in scope, and cross-org rows never surface.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupContextTestData,
  createContextOrgWith,
  createTestPortfolio,
  withOrgHeader,
  primeAiFake,
  resetAiFake,
  getAiFakeLog
} from '../helpers'

interface Conversation { id: string }

async function start(opts: object, body: Record<string, string>): Promise<Conversation> {
  const res = await $fetch<{ conversation: Conversation }>('/api/context/assistant/conversations', { method: 'POST', body, ...opts })
  return res.conversation
}

describe('assistant search', () => {
  const sql = getHostAdminDb()
  beforeEach(async () => {
    await resetAiFake()
  })
  afterEach(async () => {
    await cleanupContextTestData(sql)
    await resetAiFake()
  })

  async function seed() {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const p = await createTestPortfolio(sql, { org_id: org.id, name: 'Acme', created_by: user.id })
    await $fetch(`/api/context/portfolios/${p.slug}/sections/identity`, { method: 'PUT', body: { content: 'Acme forges anvils and horseshoes in Springfield.' }, ...opts })
    await $fetch(`/api/context/portfolios/${p.slug}/sections/team`, { method: 'PUT', body: { content: 'Wile is the founder. Roadrunner handles logistics.' }, ...opts })
    // Another org with a tempting section the search must never return.
    const other = await createContextOrgWith(sql, ['admin'])
    const op = await createTestPortfolio(sql, { org_id: other.org.id, name: 'Other', created_by: other.user.id })
    await $fetch(`/api/context/portfolios/${op.slug}/sections/identity`, { method: 'PUT', body: { content: 'Secret anvils horseshoes Springfield forge.' }, ...withOrgHeader(other.auth, other.org.slug) })
    return { org, p, opts }
  }

  function systemParts(call: { system: unknown }): string[] {
    const s = call.system
    if (typeof s === 'string') return [s]
    return Array.isArray(s) ? s.map((p: { text: string }) => p.text) : []
  }

  it('injects hits for the message as a non-cached second system part', async () => {
    const { p, opts } = await seed()
    const conv = await start(opts, { portfolio: p.slug, section: 'team' })
    await primeAiFake({ text: 'ok' })
    await $fetch(`/api/context/assistant/conversations/${conv.id}/messages`, { method: 'POST', body: { message: 'anvils horseshoes Springfield' }, ...opts })
    const call = (await getAiFakeLog()).find(c => c.kind === 'complete')!
    const parts = systemParts(call)
    expect(parts).toHaveLength(2)
    expect(parts[1]).toContain('Search hits for the latest message')
    expect(parts[1]).toContain('`identity`')
    expect(parts[1]).not.toContain('Secret')
    const raw = call.system as Array<{ cache?: boolean }>
    expect(raw[0]!.cache).toBe(true)
    expect(raw[1]!.cache).toBeUndefined()
    expect(call.tools).toContain('search_sections')
  })

  it('search_sections answers with scoped hits only', async () => {
    const { p, opts } = await seed()
    const conv = await start(opts, { portfolio: p.slug, section: 'identity' })
    await primeAiFake({ text: 'ok', toolCalls: [{ name: 'search_sections', input: { query: 'founder logistics' } }] })
    await $fetch(`/api/context/assistant/conversations/${conv.id}/messages`, { method: 'POST', body: { message: 'who runs it' }, ...opts })
    const call = (await getAiFakeLog()).find(c => c.kind === 'complete')!
    const result = call.toolResults[0]!.result
    expect(result).toContain('`team`')
    expect(result).not.toContain('Secret')
  })

  it('gives the portfolio scope no search (everything is preloaded)', async () => {
    const { p, opts } = await seed()
    const conv = await start(opts, { portfolio: p.slug })
    await primeAiFake({ text: 'ok' })
    await $fetch(`/api/context/assistant/conversations/${conv.id}/messages`, { method: 'POST', body: { message: 'anything' }, ...opts })
    const call = (await getAiFakeLog()).find(c => c.kind === 'complete')!
    expect(call.tools).not.toContain('search_sections')
    expect(systemParts(call)).toHaveLength(1)
  })
})
