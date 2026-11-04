// Search across a widget's libraries: hits come only from the listed
// libraries, page refs outside them are unknown to load_page, and the auto-
// search plus search tool return both website pages and portfolio sections.
import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from 'vitest'
import {
  getHostAdminDb,
  cleanupHelpinatorTestData,
  createHelpinatorOrgWith,
  createWebsiteLibrary,
  addSource,
  waitForSync,
  startFixtureSite,
  seedDocsTree,
  article,
  seedPortfolio,
  seedLibrary,
  seedWidget,
  sendTurn,
  primeAiFake,
  resetAiFake,
  getAiFakeLog,
  type FixtureSite
} from '../helpers'

describe('library search', () => {
  const sql = getHostAdminDb()
  let site: FixtureSite

  beforeAll(async () => {
    site = await startFixtureSite()
  })
  afterAll(async () => {
    await site.close()
  })
  beforeEach(async () => {
    await cleanupHelpinatorTestData(sql)
    await resetAiFake()
    site.pages.clear()
    seedDocsTree(site)
    site.pages.set('/blog', { html: `<!doctype html><html><head><title>Blog</title></head><body><main><h1>Blog</h1><p>Our blog, where we write about the company and publish news for customers and partners on a regular basis.</p><a href="/blog/zebras">Zebras</a></main></body></html>` })
    site.pages.set('/blog/zebras', { html: article('Zebras', 'zebra stripes') })
  })
  afterEach(async () => {
    await cleanupHelpinatorTestData(sql)
    await resetAiFake()
  })

  async function setup() {
    const { org, opts } = await createHelpinatorOrgWith(sql)
    const docs = await createWebsiteLibrary(opts, 'Docs')
    await addSource(opts, docs.id, `${site.origin}/docs`, { restrict_to_path: true, max_pages: 10 })
    const blog = await createWebsiteLibrary(opts, 'Blog')
    await addSource(opts, blog.id, `${site.origin}/blog`, { restrict_to_path: true, max_pages: 10 })
    await waitForSync(opts, docs.id)
    await waitForSync(opts, blog.id)
    const p = await seedPortfolio(sql, org.id, 'Handbook', { faq: 'Opening hours are 9-5.', returns: 'Returns are accepted within 30 days for anvils.' })
    const handbook = await seedLibrary(sql, { orgId: org.id, name: 'Handbook', portfolioId: p.id })
    const zebraPage = (await sql<{ id: string }[]>`SELECT id FROM helpinator_library_pages WHERE library_id = ${blog.id} AND url LIKE '%/blog/zebras'`)[0]!
    return { org, opts, docs, blog, handbook, zebraPage }
  }

  function hitsPart(call: { system: unknown }): string {
    return (call.system as Array<{ text: string }>)[1]?.text ?? ''
  }

  it('auto-search hits and search-tool hits come only from the widget\'s libraries', async () => {
    const { org, docs, blog, zebraPage } = await setup()
    const widget = await seedWidget(sql, { orgId: org.id, libraryIds: [docs.id] })
    await primeAiFake({ text: 'ok', toolCalls: [{ name: 'search', input: { query: 'zebra stripes' } }] })
    await sendTurn(widget.id, 'tell me about zebra stripes')
    const call = (await getAiFakeLog()).find(c => c.kind === 'complete')!
    expect(hitsPart(call)).not.toContain('Zebras')
    expect(hitsPart(call)).not.toContain('[Blog]')
    expect(call.toolResults[0]!.result).not.toContain('Zebras')
    expect(JSON.stringify(call)).not.toContain(zebraPage.id)

    // Same query on a widget that lists both: the zebra page surfaces.
    const both = await seedWidget(sql, { orgId: org.id, libraryIds: [docs.id, blog.id] })
    await resetAiFake()
    await primeAiFake({ text: 'ok' })
    const turn = await sendTurn(both.id, 'tell me about zebra stripes')
    const call2 = (await getAiFakeLog()).find(c => c.kind === 'complete')!
    expect(hitsPart(call2)).toContain('Zebras')
    expect(hitsPart(call2)).toContain(`page:${zebraPage.id}`)
    const [row] = await sql`SELECT search_hits FROM helpinator_messages WHERE id = ${turn.assistantMessage.id}`
    expect(row!.search_hits).toContainEqual({ ref: `page:${zebraPage.id}`, title: 'Zebras', url: `${site.origin}/blog/zebras` })
  })

  it('load_page reads a page ref from a listed library and refuses one from an unlisted library', async () => {
    const { org, docs, zebraPage } = await setup()
    const anvils = (await sql<{ id: string }[]>`SELECT id FROM helpinator_library_pages WHERE library_id = ${docs.id} AND url LIKE '%/docs/anvils'`)[0]!
    const widget = await seedWidget(sql, { orgId: org.id, libraryIds: [docs.id] })
    await primeAiFake({
      text: 'ok',
      toolCalls: [
        { name: 'load_page', input: { ref: `page:${anvils.id}` } },
        { name: 'load_page', input: { ref: `page:${zebraPage.id}` } }
      ]
    })
    const turn = await sendTurn(widget.id, 'anvils?')
    const call = (await getAiFakeLog()).find(c => c.kind === 'complete')!
    expect(call.toolResults[0]!.result).toContain('anvil forging paragraph 1')
    expect(call.toolResults[0]!.result).toContain(`Source: ${site.origin}/docs/anvils`)
    expect(call.toolResults[1]!.result).toMatch(/unknown page/)
    const [row] = await sql`SELECT pages_loaded FROM helpinator_messages WHERE id = ${turn.assistantMessage.id}`
    expect(row!.pages_loaded).toEqual([{ ref: `page:${anvils.id}`, title: 'Anvils', url: `${site.origin}/docs/anvils` }])
  })

  it('mixes website pages and portfolio sections, and the website default lists its pages in the prompt', async () => {
    const { org, docs, handbook } = await setup()
    const widget = await seedWidget(sql, { orgId: org.id, libraryIds: [docs.id, handbook.id] })
    await primeAiFake({ text: 'ok', toolCalls: [{ name: 'load_page', input: { ref: `section:${handbook.id}:returns` } }] })
    await sendTurn(widget.id, 'returns for anvils')
    const call = (await getAiFakeLog()).find(c => c.kind === 'complete')!
    const system = (call.system as Array<{ text: string }>)[0]!.text
    expect(system).toContain('## Index of "Docs"')
    expect(system).toContain(`${site.origin}/docs/anvils`)
    expect(system).toContain('(Nothing loaded yet.)')
    expect(hitsPart(call)).toContain(`section:${handbook.id}:returns`)
    expect(hitsPart(call)).toContain('[Handbook]')
    expect(call.toolResults[0]!.result).toContain('Returns are accepted within 30 days')
  })

  it('chunks embedded with another model never match (until the re-embed)', async () => {
    const { org, blog, handbook, zebraPage } = await setup()
    await sql`UPDATE helpinator_library_chunks SET model = 'old/model' WHERE library_id = ${blog.id}`
    await sql`UPDATE context_section_chunks SET model = 'old/model' WHERE portfolio_id = (SELECT portfolio_id FROM helpinator_libraries WHERE id = ${handbook.id})`
    const widget = await seedWidget(sql, { orgId: org.id, libraryIds: [blog.id, handbook.id] })
    await primeAiFake({ text: 'ok' })
    await sendTurn(widget.id, 'tell me about zebra stripes and returns')
    const call = (await getAiFakeLog()).find(c => c.kind === 'complete')!
    expect(hitsPart(call)).not.toContain(zebraPage.id)
    expect(hitsPart(call)).not.toContain('returns')
    expect(hitsPart(call)).toContain('(no matches)')
  })
})
