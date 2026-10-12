// The website crawler against an in-process fixture site: discovery rules
// (same host, one hop, path restriction, max pages, skipped PDFs and off-site
// links, robots.txt), readability extraction to markdown, the content-hash
// skip on re-crawl, vanished pages, per-library URL ownership, and pruning.
import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupHelpinatorTestData,
  createHelpinatorOrgWith,
  createWebsiteLibrary,
  addSource,
  getLibrary,
  waitForSync,
  startFixtureSite,
  seedDocsTree,
  article,
  resetAiFake,
  primeAiFake,
  longOpenTransactions,
  type FixtureSite
} from '../helpers'

describe('website crawl', () => {
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
    site.hits.length = 0
    seedDocsTree(site)
  })
  afterEach(async () => {
    await cleanupHelpinatorTestData(sql)
  })

  async function pagesOf(libraryId: string) {
    return await sql<{ url: string, title: string, content: string, source_id: string, content_hash: string }[]>`
      SELECT url, title, content, source_id, content_hash FROM helpinator_library_pages WHERE library_id = ${libraryId} ORDER BY url
    `
  }

  it('crawls the start page and its same-path links, extracts markdown, and indexes chunks', async () => {
    const { opts } = await createHelpinatorOrgWith(sql)
    const lib = await createWebsiteLibrary(opts)
    const source = await addSource(opts, lib.id, `${site.origin}/docs`, { restrict_to_path: true, max_pages: 10 })
    expect(source.status).toBe('syncing')

    const done = await waitForSync(opts, lib.id)
    const s = done.sources[0]!
    expect(s.status).toBe('done')
    expect(s.last_error).toBeNull()

    const pages = await pagesOf(lib.id)
    // /docs, /docs/anvils, /docs/horseshoes — not /pricing (off path), not
    // example.com (off host), not the PDF, not /docs/secret (robots).
    expect(pages.map(p => p.url)).toEqual([`${site.origin}/docs`, `${site.origin}/docs/anvils`, `${site.origin}/docs/horseshoes`])
    expect(s.page_count).toBe(3)
    expect(s.run_total).toBe(3)
    expect(s.run_done).toBe(3)
    expect(site.hits).not.toContain('/docs/secret')
    expect(site.hits).not.toContain('/pricing')

    const anvils = pages.find(p => p.url.endsWith('/docs/anvils'))!
    expect(anvils.title).toBe('Anvils')
    expect(anvils.content).toContain('anvil forging paragraph 1')
    expect(anvils.content).not.toContain('Pricing') // nav stripped
    expect(anvils.content).not.toContain('<p>')

    const chunks = await sql<{ n: number, models: string[] }[]>`
      SELECT count(*)::int AS n, array_agg(DISTINCT model) AS models FROM helpinator_library_chunks WHERE library_id = ${lib.id}
    `
    expect(chunks[0]!.n).toBeGreaterThanOrEqual(3)
    expect(chunks[0]!.models).toEqual(['test/embed-small'])
    expect(done.stats.pages).toBe(3)
    expect(done.stats.models).toEqual(['test/embed-small'])
  })

  it('without the path restriction it follows every same-host link one hop, capped by max_pages', async () => {
    const { opts } = await createHelpinatorOrgWith(sql)
    const lib = await createWebsiteLibrary(opts)
    await addSource(opts, lib.id, `${site.origin}/docs`, { restrict_to_path: false, max_pages: 3 })
    const done = await waitForSync(opts, lib.id)
    expect(done.sources[0]!.status).toBe('done')
    const pages = await pagesOf(lib.id)
    expect(pages).toHaveLength(3)
    expect(pages[0]!.url).toBe(`${site.origin}/docs`)
  })

  it('re-crawl skips unchanged pages, re-embeds changed ones, and drops vanished ones', async () => {
    const { opts } = await createHelpinatorOrgWith(sql)
    const lib = await createWebsiteLibrary(opts)
    const source = await addSource(opts, lib.id, `${site.origin}/docs`, { restrict_to_path: true, max_pages: 10 })
    await waitForSync(opts, lib.id)
    const before = await pagesOf(lib.id)
    const horseshoesBefore = before.find(p => p.url.endsWith('/docs/horseshoes'))!
    const embedsBefore = (await $fetch<Array<{ kind: string }>>('/api/_test/ai')).filter(c => c.kind === 'embed').length

    // Change anvils; horseshoes vanishes from the site (still linked → 404).
    site.pages.set('/docs/anvils', { html: article('Anvils', 'anvil forging', '<p>NEW-SENTENCE about tempering.</p>') })
    site.pages.delete('/docs/horseshoes')

    await $fetch(`/api/helpinator/libraries/${lib.id}/sources/${source.id}/sync`, { method: 'POST', ...opts })
    const done = await waitForSync(opts, lib.id)
    expect(done.sources[0]!.status).toBe('done')

    const after = await pagesOf(lib.id)
    expect(after.map(p => p.url)).toEqual([`${site.origin}/docs`, `${site.origin}/docs/anvils`])
    expect(after.find(p => p.url.endsWith('/docs/anvils'))!.content).toContain('NEW-SENTENCE')
    expect(after.find(p => p.url.endsWith('/docs/horseshoes'))).toBeUndefined()
    // Unchanged /docs index was not re-embedded; changed anvils was: exactly one more embed call.
    const embedsAfter = (await $fetch<Array<{ kind: string }>>('/api/_test/ai')).filter(c => c.kind === 'embed').length
    expect(embedsAfter - embedsBefore).toBe(1)
    // Horseshoes' chunks are gone with the page.
    const orphan = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM helpinator_library_chunks WHERE page_id = (SELECT id FROM helpinator_library_pages WHERE content_hash = ${horseshoesBefore.content_hash})`
    expect(orphan[0]!.n).toBe(0)
  })

  it('a page over the entry\'s size cap keeps its last copy and is named in the notice; raising the cap reads it', async () => {
    const { opts } = await createHelpinatorOrgWith(sql)
    const lib = await createWebsiteLibrary(opts)
    const source = await addSource(opts, lib.id, `${site.origin}/docs`, { restrict_to_path: true, max_pages: 10, max_page_mb: 1 })
    await waitForSync(opts, lib.id)

    // Anvils grows past 1 MB.
    const padding = `<p>${'big anvil table row '.repeat(60_000)}</p>`
    site.pages.set('/docs/anvils', { html: article('Anvils', 'anvil forging', `<p>GREW-PAST-CAP</p>${padding}`) })
    await $fetch(`/api/helpinator/libraries/${lib.id}/sources/${source.id}/sync`, { method: 'POST', ...opts })
    let done = await waitForSync(opts, lib.id)
    let s = done.sources[0]!
    expect(s.status).toBe('done')
    expect(s.max_page_mb).toBe(1)
    expect(s.last_error).toContain('1 page(s) over the 1 MB page limit')
    expect(s.last_error).toContain(`${site.origin}/docs/anvils`)
    let anvils = (await pagesOf(lib.id)).find(p => p.url.endsWith('/docs/anvils'))!
    expect(anvils.content).toContain('anvil forging paragraph 1')
    expect(anvils.content).not.toContain('GREW-PAST-CAP')

    // Raise the cap: the next crawl reads it and the notice clears. A PUT
    // without max_page_mb keeps the raised value.
    await $fetch(`/api/helpinator/libraries/${lib.id}/sources/${source.id}`, { method: 'PUT', body: { restrict_to_path: true, max_pages: 10, max_page_mb: 3 }, ...opts })
    await $fetch(`/api/helpinator/libraries/${lib.id}/sources/${source.id}`, { method: 'PUT', body: { restrict_to_path: true, max_pages: 10 }, ...opts })
    await $fetch(`/api/helpinator/libraries/${lib.id}/sources/${source.id}/sync`, { method: 'POST', ...opts })
    done = await waitForSync(opts, lib.id)
    s = done.sources[0]!
    expect(s.max_page_mb).toBe(3)
    expect(s.last_error).toBeNull()
    anvils = (await pagesOf(lib.id)).find(p => p.url.endsWith('/docs/anvils'))!
    expect(anvils.content).toContain('GREW-PAST-CAP')
  })

  it('reports a start page over the size cap as an error', async () => {
    site.pages.set('/huge', { html: article('Huge', 'huge page', `<p>${'x'.repeat(1_200_000)}</p>`) })
    const { opts } = await createHelpinatorOrgWith(sql)
    const lib = await createWebsiteLibrary(opts)
    await addSource(opts, lib.id, `${site.origin}/huge`, { max_pages: 1, max_page_mb: 1 })
    const s = (await waitForSync(opts, lib.id)).sources[0]!
    expect(s.status).toBe('error')
    expect(s.last_error).toContain('Start page is over the 1 MB page limit')
  })

  it('a URL reached from two sources of one library belongs to the first, and pruning removes a page', async () => {
    const { opts } = await createHelpinatorOrgWith(sql)
    const lib = await createWebsiteLibrary(opts)
    const docs = await addSource(opts, lib.id, `${site.origin}/docs`, { restrict_to_path: true, max_pages: 10 })
    await waitForSync(opts, lib.id)
    // The home page links /docs/anvils too.
    const home = await addSource(opts, lib.id, `${site.origin}/`, { restrict_to_path: false, max_pages: 10 })
    const done = await waitForSync(opts, lib.id)
    expect(done.sources.map(s => s.status)).toEqual(['done', 'done'])
    const pages = await pagesOf(lib.id)
    expect(pages.find(p => p.url.endsWith('/docs/anvils'))!.source_id).toBe(docs.id)
    expect(pages.filter(p => p.source_id === home.id).map(p => p.url)).toEqual([`${site.origin}/`, `${site.origin}/pricing`])

    const listed = await $fetch<{ pages: Array<{ id: string, url: string }> }>(`/api/helpinator/libraries/${lib.id}/pages`, { query: { source: home.id }, ...opts })
    const pricing = listed.pages.find(p => p.url.endsWith('/pricing'))!
    const view = await $fetch<{ content: string }>(`/api/helpinator/libraries/${lib.id}/pages/${pricing.id}`, { ...opts })
    expect(view.content).toContain('pricing plans')
    await $fetch(`/api/helpinator/libraries/${lib.id}/pages/${pricing.id}`, { method: 'DELETE', ...opts })
    expect((await pagesOf(lib.id)).some(p => p.url.endsWith('/pricing'))).toBe(false)

    // Removing a source takes its pages with it, and only its pages.
    await $fetch(`/api/helpinator/libraries/${lib.id}/sources/${home.id}`, { method: 'DELETE', ...opts })
    expect((await pagesOf(lib.id)).map(p => p.url)).toEqual([`${site.origin}/docs`, `${site.origin}/docs/anvils`, `${site.origin}/docs/horseshoes`])
  })

  it('keeps a page\'s content when readability would return only the site menu', async () => {
    // Elementor/WordPress shape: readability picks the page-wide wrapper, then
    // drops the content blocks because their class says "widget", leaving the
    // menu. A pick that is mostly links falls back to the stripped body.
    const links = Array.from({ length: 12 }, (_, i) => `<li><a href="/m${i}">Menu entry ${i}</a></li>`).join('')
    site.pages.set('/mobile', { html: `<!doctype html><html><head><title>Mobile App</title></head><body>
<div class="off-canvas-wrapper"><ul class="menu">${links}</ul>
<div class="elementor-widget-wrap"><div class="elementor-widget">
<p><b>The mobile app is no longer in development.</b></p>
<p>Development continued through 2023, but with limited usage and a complex setup the app is no longer maintained. It is still in the app stores, but some features may not work. Use a mobile browser instead.</p>
</div></div></div>
</body></html>` })
    const { opts } = await createHelpinatorOrgWith(sql)
    const lib = await createWebsiteLibrary(opts)
    await addSource(opts, lib.id, `${site.origin}/mobile`, { restrict_to_path: true, max_pages: 1 })
    const done = await waitForSync(opts, lib.id)
    expect(done.sources[0]!.status).toBe('done')

    const [page] = await pagesOf(lib.id)
    expect(page!.content).toContain('no longer in development')
    expect(page!.content).toContain('Use a mobile browser instead')
    expect(page!.content).not.toContain('Menu entry')
  })

  it('keeps a listing page\'s links while still dropping an unmarked menu', async () => {
    // Mostly links, so readability's pick is rejected; the fallback must tell
    // descriptive entries (content) from short labels (menu).
    const items = ['Getting started guide for new planters', 'Training videos on disciple making', 'How to set up your prayer team', 'Downloadable coaching checklist as a PDF', 'Questions people ask about the mobile app', 'Contact the support team for account help']
    const list = items.map((t, i) => `<li><a href="/r${i}">${t}</a></li>`).join('')
    const menu = ['Home', 'About', 'Blog', 'Contact us', 'Give'].map((t, i) => `<li><a href="/m${i}">${t}</a></li>`).join('')
    site.pages.set('/resources', { html: `<!doctype html><html><head><title>Resources</title></head><body>
<div class="top"><ul>${menu}</ul></div>
<div class="content"><h1>Resources</h1><p>Everything below.</p><ul>${list}</ul></div>
</body></html>` })
    const { opts } = await createHelpinatorOrgWith(sql)
    const lib = await createWebsiteLibrary(opts)
    await addSource(opts, lib.id, `${site.origin}/resources`, { restrict_to_path: true, max_pages: 1 })
    const done = await waitForSync(opts, lib.id)
    expect(done.sources[0]!.status).toBe('done')

    const [page] = await pagesOf(lib.id)
    for (const item of items) expect(page!.content).toContain(item)
    expect(page!.content).not.toContain('Contact us')
  })

  it('reports an unreachable start page as an error and never blocks a re-sync', async () => {
    const { opts } = await createHelpinatorOrgWith(sql)
    const lib = await createWebsiteLibrary(opts)
    const source = await addSource(opts, lib.id, `${site.origin}/missing`)
    let done = await waitForSync(opts, lib.id)
    expect(done.sources[0]!.status).toBe('error')
    expect(done.sources[0]!.last_error).toMatch(/404/)

    // A stuck "syncing" row is no obstacle: the next sync supersedes it.
    await sql`UPDATE helpinator_library_sources SET status = 'syncing', run_token = gen_random_uuid() WHERE id = ${source.id}`
    site.pages.set('/missing', { html: article('Found', 'found now') })
    const res = await $fetch<{ status: string }>(`/api/helpinator/libraries/${lib.id}/sources/${source.id}/sync`, { method: 'POST', ...opts })
    expect(res.status).toBe('syncing')
    done = await waitForSync(opts, lib.id)
    expect(done.sources[0]!.status).toBe('done')
    expect(done.sources[0]!.page_count).toBe(1)
    expect(await getLibrary(opts, lib.id)).toMatchObject({ stats: { pages: 1 } })
  })

  it('refuses internal addresses as sources', async () => {
    const { opts } = await createHelpinatorOrgWith(sql)
    const lib = await createWebsiteLibrary(opts)
    for (const url of ['http://169.254.169.254/latest/meta-data', 'http://10.0.0.1/', 'http://[::ffff:169.254.169.254]/', 'http://[fd00::1]/']) {
      const err = await addSource(opts, lib.id, url).catch(e => e)
      expect(err.statusCode, url).toBe(400)
    }
  })

  it('does not follow a redirect to an internal address', async () => {
    const { opts } = await createHelpinatorOrgWith(sql)
    const lib = await createWebsiteLibrary(opts)
    site.pages.set('/docs', { html: '', redirect: 'http://169.254.169.254/latest/meta-data/' })
    await addSource(opts, lib.id, `${site.origin}/docs`)
    const done = await waitForSync(opts, lib.id)
    expect(done.sources[0]!.status).toBe('error')
    expect(done.sources[0]!.last_error).toMatch(/not a public address/)
    expect(await pagesOf(lib.id)).toHaveLength(0)
  })

  it('resolves links against where the start page redirected to', async () => {
    const { opts } = await createHelpinatorOrgWith(sql)
    const lib = await createWebsiteLibrary(opts)
    // The stored URL loses its trailing slash; the site redirects back to it,
    // and its relative links only make sense against the slashed URL.
    site.pages.set('/guide', { html: '', redirect: '/guide/' })
    site.pages.set('/guide/', {
      html: `<!doctype html><html><head><title>Guide</title></head><body><main>
<h1>Guide</h1><p>The guide index lists every chapter of the guide we publish for the product and links to each one below.</p>
<ul><li><a href="intro">Intro</a></li><li><a href="./setup">Setup</a></li><li><a href="/guide/">Index</a></li></ul>
</main></body></html>`
    })
    site.pages.set('/guide/intro', { html: article('Intro', 'guide intro') })
    site.pages.set('/guide/setup', { html: article('Setup', 'guide setup') })
    await addSource(opts, lib.id, `${site.origin}/guide/`, { restrict_to_path: true, max_pages: 10 })
    const done = await waitForSync(opts, lib.id)
    expect(done.sources[0]!.status).toBe('done')
    expect((await pagesOf(lib.id)).map(p => p.url)).toEqual([`${site.origin}/guide`, `${site.origin}/guide/intro`, `${site.origin}/guide/setup`])
  })

  it('stops reading a page body past the size cap', async () => {
    const { opts } = await createHelpinatorOrgWith(sql)
    const lib = await createWebsiteLibrary(opts)
    site.pages.set('/docs/anvils', { html: '<p>filler filler filler</p>', streamBytes: 50 * 1024 * 1024 })
    await addSource(opts, lib.id, `${site.origin}/docs`, { restrict_to_path: true, max_pages: 10 })
    const done = await waitForSync(opts, lib.id)
    expect(done.sources[0]!.status).toBe('done')
    const urls = (await pagesOf(lib.id)).map(p => p.url)
    expect(urls).toContain(`${site.origin}/docs`)
    expect(urls).not.toContain(`${site.origin}/docs/anvils`)
  })

  it('holds no DB transaction open while embedding a page', async () => {
    const { opts } = await createHelpinatorOrgWith(sql)
    const lib = await createWebsiteLibrary(opts)
    await primeAiFake({ embedDelayMs: 1500 })
    await addSource(opts, lib.id, `${site.origin}/docs`, { restrict_to_path: true, max_pages: 10 })
    await new Promise(r => setTimeout(r, 1200))
    expect(await longOpenTransactions()).toBe(0)
    const done = await waitForSync(opts, lib.id)
    expect(done.sources[0]!.status).toBe('done')
    expect(done.sources[0]!.page_count).toBe(3)
  })

  it('a transient failure on re-crawl keeps the stored page', async () => {
    const { opts } = await createHelpinatorOrgWith(sql)
    const lib = await createWebsiteLibrary(opts)
    const source = await addSource(opts, lib.id, `${site.origin}/docs`, { restrict_to_path: true, max_pages: 10 })
    await waitForSync(opts, lib.id)
    site.pages.set('/docs/anvils', { html: 'busy', status: 503 })
    await $fetch(`/api/helpinator/libraries/${lib.id}/sources/${source.id}/sync`, { method: 'POST', ...opts })
    const done = await waitForSync(opts, lib.id)
    expect(done.sources[0]!.status).toBe('done')
    expect(done.sources[0]!.last_error).toMatch(/503/)
    expect((await pagesOf(lib.id)).map(p => p.url)).toContain(`${site.origin}/docs/anvils`)
  })

  it('one page failing to index does not fail the run', async () => {
    const { opts } = await createHelpinatorOrgWith(sql)
    const lib = await createWebsiteLibrary(opts)
    // The AI fake fails any embedding input containing [[fail]]; the title
    // heads every chunk unescaped.
    site.pages.set('/docs/anvils', { html: article('Anvils [[fail]]', 'anvil forging') })
    await addSource(opts, lib.id, `${site.origin}/docs`, { restrict_to_path: true, max_pages: 10 })
    const done = await waitForSync(opts, lib.id)
    expect(done.sources[0]!.status).toBe('done')
    expect(done.sources[0]!.last_error).toMatch(/1 page\(s\) failed/)
    expect((await pagesOf(lib.id)).map(p => p.url)).toEqual([`${site.origin}/docs`, `${site.origin}/docs/horseshoes`])
  })

  it('two sources crawling the same URLs at once both finish', async () => {
    const { opts } = await createHelpinatorOrgWith(sql)
    const lib = await createWebsiteLibrary(opts)
    // Both reach /docs and its articles (the home page links them too).
    await Promise.all([
      addSource(opts, lib.id, `${site.origin}/docs`, { restrict_to_path: true, max_pages: 10 }),
      addSource(opts, lib.id, `${site.origin}/`, { restrict_to_path: false, max_pages: 10 })
    ])
    const done = await waitForSync(opts, lib.id)
    expect(done.sources.map(s => s.status)).toEqual(['done', 'done'])
    const urls = (await pagesOf(lib.id)).map(p => p.url)
    expect(new Set(urls).size).toBe(urls.length)
  })

  it('a run whose process died is shown as interrupted, not syncing forever', async () => {
    const { opts } = await createHelpinatorOrgWith(sql)
    const lib = await createWebsiteLibrary(opts)
    const source = await addSource(opts, lib.id, `${site.origin}/docs`)
    await waitForSync(opts, lib.id)
    await sql`UPDATE helpinator_library_sources SET status = 'syncing', run_token = gen_random_uuid(), run_heartbeat_at = now() - interval '10 minutes' WHERE id = ${source.id}`
    const lib2 = await getLibrary(opts, lib.id)
    expect(lib2.sources[0]!.status).toBe('error')
    expect(lib2.sources[0]!.last_error).toMatch(/interrupted/)
  })

  it('the scheduled sweep re-crawls only sources whose last sync is older than the max age, across orgs', async () => {
    const a = await createHelpinatorOrgWith(sql)
    const b = await createHelpinatorOrgWith(sql)
    const libA = await createWebsiteLibrary(a.opts)
    const libB = await createWebsiteLibrary(b.opts)
    const stale = await addSource(a.opts, libA.id, `${site.origin}/docs`, { restrict_to_path: true, max_pages: 10 })
    const fresh = await addSource(b.opts, libB.id, `${site.origin}/docs`, { restrict_to_path: true, max_pages: 10 })
    await waitForSync(a.opts, libA.id)
    await waitForSync(b.opts, libB.id)
    await sql`UPDATE helpinator_library_sources SET run_started_at = now() - interval '8 days', last_synced_at = now() - interval '8 days' WHERE id = ${stale.id}`
    const [freshBefore] = await sql<{ last_synced_at: Date }[]>`SELECT last_synced_at FROM helpinator_library_sources WHERE id = ${fresh.id}`

    site.pages.set('/docs/anvils', { html: article('Anvils', 'anvil forging', '<p>WEEKLY-UPDATE about quenching.</p>') })
    const res = await $fetch<{ started: number }>('/api/_test/helpinator-sync-sweep', { method: 'POST', body: { maxAgeDays: 7 } })
    expect(res.started).toBe(1)

    const rows = await sql<{ id: string, status: string, last_synced_at: Date }[]>`
      SELECT id, status, last_synced_at FROM helpinator_library_sources WHERE id IN (${stale.id}, ${fresh.id})
    `
    const staleRow = rows.find(r => r.id === stale.id)!
    expect(staleRow.status).toBe('done')
    expect(Date.now() - staleRow.last_synced_at.getTime()).toBeLessThan(60_000)
    expect(rows.find(r => r.id === fresh.id)!.last_synced_at.getTime()).toBe(freshBefore!.last_synced_at.getTime())
    expect((await pagesOf(libA.id)).find(p => p.url.endsWith('/docs/anvils'))!.content).toContain('WEEKLY-UPDATE')

    // Now nothing is due.
    expect((await $fetch<{ started: number }>('/api/_test/helpinator-sync-sweep', { method: 'POST', body: { maxAgeDays: 7 } })).started).toBe(0)
  })

  it('a scheduled run cut off by a restart is due again on the next sweep, not counted as fresh', async () => {
    const { opts } = await createHelpinatorOrgWith(sql)
    const lib = await createWebsiteLibrary(opts)
    const source = await addSource(opts, lib.id, `${site.origin}/docs`, { restrict_to_path: true, max_pages: 10 })
    await waitForSync(opts, lib.id)
    // Queued by a sweep (stamped just now), then the process died.
    await sql`UPDATE helpinator_library_sources SET status = 'syncing', run_token = gen_random_uuid(), run_started_at = now() - interval '10 minutes', run_heartbeat_at = now() - interval '10 minutes', last_synced_at = now() - interval '8 days' WHERE id = ${source.id}`

    const res = await $fetch<{ started: number }>('/api/_test/helpinator-sync-sweep', { method: 'POST', body: { maxAgeDays: 7 } })
    expect(res.started).toBeGreaterThanOrEqual(1)
    const [row] = await sql<{ status: string, last_synced_at: Date }[]>`SELECT status, last_synced_at FROM helpinator_library_sources WHERE id = ${source.id}`
    expect(row!.status).toBe('done')
    expect(Date.now() - row!.last_synced_at.getTime()).toBeLessThan(60_000)
  })

  it('the scheduled sweep accepts a fractional max age', async () => {
    const res = await $fetch<{ started: number }>('/api/_test/helpinator-sync-sweep', { method: 'POST', body: { maxAgeDays: 1.5 } })
    expect(res.started).toBeGreaterThanOrEqual(0)
  })
})
