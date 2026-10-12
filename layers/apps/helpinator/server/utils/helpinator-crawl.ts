// The website-library crawler: discover the pages one hop from a source URL,
// extract each page's main content as markdown, store it, and embed it.
//
// A run is fire-and-forget: the route stamps the source `syncing` with a fresh
// run token and returns; the run then does its work in short org-scoped
// transactions (never holding one across a network call). Every write
// re-checks the token, so a newer run for the same source supersedes an older
// one — the older run simply stops writing. Nothing blocks a re-sync.
//
// Politeness: a named user agent, robots.txt disallows honoured, a few
// concurrent fetches with a short gap, a per-page timeout and size cap.
import { createHash, randomUUID } from 'node:crypto'
import { sql, type Transaction } from 'kysely'
import robotsParser from 'robots-parser'

import type { Database } from '#core/server/database/schema'
import { isMigrationHeldBack } from '#core/server/utils/migration-status'
import { embed, chunkMarkdown, vectorSql, resolveEmbeddingModel, resolveAiEmbedRun, type AiEmbeddingRun, type AiReindexer, type AiReindexProgress } from '#ai/server'
import type { HelpinatorSourceRow } from './helpinator-libraries'
import { helpinatorNormalizeUrl } from './helpinator-libraries'
import { helpinatorSafeFetch } from './helpinator-safe-fetch'
import { helpinatorExtract, helpinatorParseDom } from './helpinator-extract'
import { helpinatorScope, type HelpinatorScope } from './helpinator-guards'
import { helpinatorEmbedRun } from './helpinator-search'

type Tx = Transaction<Database>

export const HELPINATOR_CRAWL_USER_AGENT = 'NuxtinatorHelpinator/1.0 (+https://github.com/corsacca/nuxtinator)'
const FETCH_TIMEOUT_MS = 10_000
const MAX_HTML_BYTES = 2 * 1024 * 1024
const MAX_ROBOTS_BYTES = 512 * 1024
const CONCURRENCY = 3
const GAP_MS = 250
// How often a run queued behind another ("Sync all") refreshes its heartbeat.
const QUEUED_HEARTBEAT_MS = 60_000
// Extensions that are never HTML pages.
const SKIP_EXT_RE = /\.(pdf|jpe?g|png|gif|webp|svg|ico|css|js|mjs|json|xml|rss|atom|zip|gz|tar|mp3|mp4|mov|avi|webm|woff2?|ttf|eot|doc|docx|xls|xlsx|ppt|pptx|csv)$/i

// --- Scope transactions (the crawl has no request) ---

export async function helpinatorScopeTx<T>(orgId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return await helpinatorScope(orgId)(fn)
}

// --- Discovery ---

export interface HelpinatorCrawlPlan {
  start: string
  // Every URL to fetch, start page first, already normalised and capped.
  urls: string[]
}

function pathPrefixOf(start: URL): string {
  const p = start.pathname.replace(/\/+$/, '')
  return p || '/'
}

function underPrefix(candidate: URL, prefix: string): boolean {
  if (prefix === '/') return true
  return candidate.pathname === prefix || candidate.pathname.startsWith(`${prefix}/`)
}

// Same-host links in `html`, one hop from `start`, optionally restricted to
// paths under the start path. `base` is where the fetch of `start` ended up
// after redirects (`/docs` → `/docs/`, `site.com` → `www.site.com`): links
// resolve against it and its host and path are the ones that count.
// Pure — exported for tests.
export function helpinatorDiscoverLinks(html: string, start: string, opts: { restrictToPath: boolean, maxPages: number, base?: string }): HelpinatorCrawlPlan {
  const baseUrl = new URL(opts.base ?? start)
  const prefix = pathPrefixOf(baseUrl)
  const urls: string[] = [start]
  const seen = new Set<string>([start])
  const normalizedBase = helpinatorNormalizeUrl(baseUrl.toString())
  if (normalizedBase) seen.add(normalizedBase)
  const document = helpinatorParseDom(html)
  for (const a of Array.from(document.querySelectorAll('a[href]'))) {
    if (urls.length >= opts.maxPages) break
    const href = a.getAttribute('href') ?? ''
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) continue
    let abs: string | null
    try {
      abs = helpinatorNormalizeUrl(new URL(href, baseUrl).toString())
    } catch {
      continue
    }
    if (!abs) continue
    const u = new URL(abs)
    if (u.hostname !== baseUrl.hostname) continue
    if (SKIP_EXT_RE.test(u.pathname)) continue
    if (opts.restrictToPath && !underPrefix(u, prefix)) continue
    if (seen.has(abs)) continue
    seen.add(abs)
    urls.push(abs)
  }
  return { start, urls }
}

// --- Extraction (see helpinator-extract.ts) ---

export function helpinatorContentHash(title: string, markdown: string): string {
  return createHash('sha256').update(title).update('\n').update(markdown).digest('hex')
}

// --- Fetching ---

async function fetchHtml(url: string): Promise<{ status: number, html: string | null, finalUrl: string }> {
  const res = await helpinatorSafeFetch(url, {
    headers: { 'user-agent': HELPINATOR_CRAWL_USER_AGENT, 'accept': 'text/html,application/xhtml+xml' },
    timeoutMs: FETCH_TIMEOUT_MS,
    maxBytes: MAX_HTML_BYTES,
    wantBody: (status, type) => status >= 200 && status < 300 && /text\/html|application\/xhtml/i.test(type)
  })
  return { status: res.status, html: res.body, finalUrl: res.finalUrl }
}

async function robotsFor(start: URL): Promise<{ isAllowed: (url: string) => boolean }> {
  const robotsUrl = `${start.origin}/robots.txt`
  try {
    const res = await helpinatorSafeFetch(robotsUrl, {
      headers: { 'user-agent': HELPINATOR_CRAWL_USER_AGENT },
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: MAX_ROBOTS_BYTES,
      wantBody: status => status >= 200 && status < 300
    })
    if (res.body === null) return { isAllowed: () => true }
    const parsed = robotsParser(robotsUrl, res.body)
    return { isAllowed: url => parsed.isAllowed(url, HELPINATOR_CRAWL_USER_AGENT) !== false }
  } catch {
    return { isAllowed: () => true }
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// --- Indexing one page ---

interface ChunkPiece { heading: string, text: string }

function chunkPage(title: string, markdown: string): ChunkPiece[] {
  return chunkMarkdown(markdown).map(c => ({
    heading: c.heading,
    text: `${title}${c.heading ? ` › ${c.heading}` : ''}\n\n${c.text}`
  }))
}

async function writeChunks(tx: Tx, pageId: string, libraryId: string, pieces: ChunkPiece[], vectors: number[][], model: string): Promise<void> {
  await tx.deleteFrom('helpinator_library_chunks').where('page_id', '=', pageId).execute()
  for (let i = 0; i < pieces.length; i++) {
    await tx
      .insertInto('helpinator_library_chunks')
      .values({
        page_id: pageId,
        library_id: libraryId,
        ordinal: i,
        heading: pieces[i]!.heading,
        content: pieces[i]!.text,
        embedding: vectorSql(vectors[i]!),
        model
      })
      .execute()
  }
}

// --- The run ---

class Superseded extends Error {}

async function assertToken(tx: Tx, sourceId: string, token: string): Promise<void> {
  const row = await tx.selectFrom('helpinator_library_sources').select('run_token').where('id', '=', sourceId).executeTakeFirst()
  if (!row || row.run_token !== token) throw new Superseded()
}

interface RunCounters {
  pages: number
  bytes: number
  skipped: number
  failed: string[]
  // URLs that failed transiently this run: their stored pages are kept.
  keep: Set<string>
}

// Fetch, extract and store one page. Three steps so no tx spans the network:
// a short tx decides what the page needs, the embedding call runs outside any
// tx, and a short tx writes (re-checking the run token and URL ownership).
// With no embedding run (no model configured) pages are stored unindexed;
// the AI settings re-embed indexes them once a model is set.
async function processUrl(orgId: string | null, source: HelpinatorSourceRow, token: string, url: string, startedAt: Date, embedRun: AiEmbeddingRun | null, counters: RunCounters): Promise<void> {
  let fetched: Awaited<ReturnType<typeof fetchHtml>>
  try {
    fetched = await fetchHtml(url)
  } catch (err) {
    // Timeouts and network errors are transient: keep the stored copy.
    counters.failed.push(`${url}: ${(err as Error)?.message ?? 'fetch failed'}`)
    counters.keep.add(url)
    return
  }
  if (fetched.status === 429 || fetched.status >= 500) {
    counters.failed.push(`${url}: HTTP ${fetched.status}`)
    counters.keep.add(url)
    return
  }
  if (!fetched.html) {
    counters.skipped++
    return
  }
  const extracted = helpinatorExtract(fetched.html, url)
  if (!extracted.markdown) {
    counters.skipped++
    return
  }
  const hash = helpinatorContentHash(extracted.title, extracted.markdown)
  const bytes = Buffer.byteLength(extracted.markdown, 'utf8')
  const pageValues = { title: extracted.title, content: extracted.markdown, content_hash: hash, bytes, fetched_at: startedAt }

  const findPage = (tx: Tx) => tx
    .selectFrom('helpinator_library_pages')
    .select(['id', 'source_id', 'content_hash'])
    .where('library_id', '=', source.library_id)
    .where('url', '=', url)
    .executeTakeFirst()

  const plan = await helpinatorScopeTx(orgId, async (tx) => {
    await assertToken(tx, source.id, token)
    const existing = await findPage(tx)
    // Another source in this library crawled the URL first: it owns the page.
    if (existing && existing.source_id !== source.id) return 'skip' as const
    if (!existing) return 'embed' as const
    const chunkModels = await tx.selectFrom('helpinator_library_chunks').select('model').distinct().where('page_id', '=', existing.id).execute()
    const upToDate = existing.content_hash === hash && (embedRun
      ? chunkModels.length === 1 && chunkModels[0]!.model === embedRun.model
      : true)
    if (!upToDate) return 'embed' as const
    await tx.updateTable('helpinator_library_pages').set(pageValues).where('id', '=', existing.id).execute()
    return 'kept' as const
  })
  if (plan === 'skip') {
    counters.skipped++
    return
  }
  if (plan === 'kept') {
    counters.pages++
    counters.bytes += bytes
    return
  }

  const pieces = chunkPage(extracted.title, extracted.markdown)
  const embedded = embedRun ? await embed({ run: embedRun, input: pieces.map(p => p.text) }) : null

  const stored = await helpinatorScopeTx(orgId, async (tx) => {
    await assertToken(tx, source.id, token)
    const existing = await findPage(tx)
    if (existing && existing.source_id !== source.id) return false
    let pageId: string
    if (existing) {
      pageId = existing.id
      await tx.updateTable('helpinator_library_pages').set(pageValues).where('id', '=', pageId).execute()
    } else {
      // Another source of this library may insert the same URL between our
      // check and here; the first one wins and owns the page.
      const inserted = await tx
        .insertInto('helpinator_library_pages')
        .values({ library_id: source.library_id, source_id: source.id, url, ...pageValues })
        .onConflict(oc => oc.columns(['library_id', 'url']).doNothing())
        .returning('id')
        .executeTakeFirst()
      if (!inserted) return false
      pageId = inserted.id
    }
    if (embedded) {
      await writeChunks(tx, pageId, source.library_id, pieces, embedded.vectors, embedded.model)
    } else {
      // Unindexed: drop chunks of the old content rather than leave them.
      await tx.deleteFrom('helpinator_library_chunks').where('page_id', '=', pageId).execute()
    }
    return true
  })
  if (!stored) {
    counters.skipped++
    return
  }
  counters.pages++
  counters.bytes += bytes
}

// Progress writes are token-guarded but never throw: a superseded run finds
// out at its next page write.
// `run_done` is incremented in SQL: the workers' updates commit in any order,
// so writing each worker's own count let a lower one land last.
async function setProgress(orgId: string | null, sourceId: string, token: string, patch: { run_total: number } | 'item-done'): Promise<void> {
  await helpinatorScopeTx(orgId, async (tx) => {
    await tx
      .updateTable('helpinator_library_sources')
      .set({ ...(patch === 'item-done' ? { run_done: sql`run_done + 1` } : patch), run_heartbeat_at: sql`now()` })
      .where('id', '=', sourceId)
      .where('run_token', '=', token)
      .execute()
  })
}

// A queued run (waiting its turn in "Sync all") has no progress to write, so
// it beats this instead, or it would look dead to `helpinatorExpireStaleRuns`.
async function heartbeat(orgId: string | null, sourceId: string, token: string): Promise<void> {
  await helpinatorScopeTx(orgId, async (tx) => {
    await tx
      .updateTable('helpinator_library_sources')
      .set({ run_heartbeat_at: sql`now()` })
      .where('id', '=', sourceId)
      .where('run_token', '=', token)
      .execute()
  })
}

async function finish(orgId: string | null, sourceId: string, token: string, patch: Partial<{ status: 'done' | 'error', page_count: number, bytes: number, last_error: string | null }>): Promise<void> {
  await helpinatorScopeTx(orgId, async (tx) => {
    await tx
      .updateTable('helpinator_library_sources')
      .set({ ...patch, last_synced_at: sql`now()` })
      .where('id', '=', sourceId)
      .where('run_token', '=', token)
      .execute()
  })
}

async function runSource(orgId: string | null, source: HelpinatorSourceRow, token: string): Promise<void> {
  const startedAt = new Date()
  const counters: RunCounters = { pages: 0, bytes: 0, skipped: 0, failed: [], keep: new Set() }
  try {
    const startUrl = new URL(source.url)
    const robots = await robotsFor(startUrl)
    if (!robots.isAllowed(source.url)) {
      await finish(orgId, source.id, token, { status: 'error', last_error: 'robots.txt disallows this URL' })
      return
    }
    const first = await fetchHtml(source.url)
    if (!first.html) {
      await finish(orgId, source.id, token, { status: 'error', last_error: `Start page returned ${first.status}${first.html === null ? ' or was not HTML' : ''}` })
      return
    }
    // Resolved once per run, in its own short tx; embeds then run outside any.
    // Null (no embedding model): pages are stored, just not indexed.
    const embedRun = await helpinatorScopeTx(orgId, tx => helpinatorEmbedRun(tx))
    const plan = helpinatorDiscoverLinks(first.html, source.url, { restrictToPath: source.restrict_to_path, maxPages: source.max_pages, base: first.finalUrl })
    const queue = plan.urls.filter(u => robots.isAllowed(u))
    await setProgress(orgId, source.id, token, { run_total: queue.length })

    // Bounded concurrency with a short gap between starts. A page's own
    // failure is recorded and the run goes on; a superseded run stops every
    // worker at its next URL.
    let next = 0
    let stopped: unknown = null
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (next < queue.length && !stopped) {
        const url = queue[next++]!
        try {
          await processUrl(orgId, source, token, url, startedAt, embedRun, counters)
        } catch (err) {
          if (err instanceof Superseded) {
            stopped = err
            return
          }
          const message = (err as { statusMessage?: string, message?: string })?.statusMessage || (err as Error)?.message || 'failed'
          console.error(`[helpinator] crawl of ${url} failed:`, err)
          counters.failed.push(`${url}: ${message}`)
          counters.keep.add(url)
        }
        await setProgress(orgId, source.id, token, 'item-done')
        await sleep(GAP_MS)
      }
    })
    await Promise.all(workers)
    if (stopped) throw stopped

    // Pages of this source not seen this run are gone from the site — except
    // those whose fetch failed transiently, which keep their last good copy.
    await helpinatorScopeTx(orgId, async (tx) => {
      await assertToken(tx, source.id, token)
      let q = tx
        .deleteFrom('helpinator_library_pages')
        .where('source_id', '=', source.id)
        .where('fetched_at', '<', startedAt)
      if (counters.keep.size) q = q.where('url', 'not in', [...counters.keep])
      await q.execute()
    })

    const errorNote = counters.failed.length ? `${counters.failed.length} page(s) failed: ${counters.failed.slice(0, 3).join('; ')}` : null
    await finish(orgId, source.id, token, { status: 'done', page_count: counters.pages, bytes: counters.bytes, last_error: errorNote })
  } catch (err) {
    if (err instanceof Superseded) return
    const message = ((err as { statusMessage?: string, message?: string })?.statusMessage || (err as Error)?.message || 'Crawl failed').slice(0, 500)
    console.error(`[helpinator] crawl of ${source.url} failed:`, err)
    await finish(orgId, source.id, token, { status: 'error', page_count: counters.pages, bytes: counters.bytes, last_error: message })
  }
}

// In-process registry of running syncs so `helpinatorSyncStatus` can say what
// this process is doing; the DB row is the source of truth across processes.
const running = new Map<string, Promise<void>>()

// Stamp the source `syncing` with a new run token and start the crawl in the
// background. Returns the token; the promise in `done` is for tests and for
// chaining ("sync all" runs a library's sources one after another via
// `opts.after`).
export async function helpinatorStartSourceSync(
  tx: Tx,
  orgId: string | null,
  source: HelpinatorSourceRow,
  opts: { after?: Promise<void> } = {}
): Promise<{ token: string, done: Promise<void> }> {
  const token = randomUUID()
  await tx
    .updateTable('helpinator_library_sources')
    .set({ status: 'syncing', run_token: token, run_started_at: sql`now()`, run_heartbeat_at: sql`now()`, run_total: 0, run_done: 0, last_error: null })
    .where('id', '=', source.id)
    .execute()
  const fresh = { ...source, status: 'syncing' as const, run_token: token, run_total: 0, run_done: 0 }
  // Start after the caller's transaction commits so the token is visible.
  const done = new Promise<void>((resolve) => {
    setTimeout(async () => {
      if (opts.after) {
        const beat = setInterval(() => {
          heartbeat(orgId, source.id, token).catch(err => console.warn('[helpinator] queued sync heartbeat failed:', err))
        }, QUEUED_HEARTBEAT_MS)
        await opts.after.catch(() => {})
        clearInterval(beat)
      }
      const p = runSource(orgId, fresh, token).finally(() => {
        if (running.get(source.id) === p) running.delete(source.id)
        resolve()
      })
      running.set(source.id, p)
    }, 50)
  })
  return { token, done }
}

// A run that hasn't written progress for this long belonged to a process
// that is gone (progress is written after every page, and one page is
// bounded by the fetch and embedding timeouts).
const STALE_RUN = '5 minutes'

// Mark this library's dead runs interrupted, so the UI stops polling and
// "Sync all" comes back. Safe across processes: a live run keeps its
// heartbeat fresh, and a newer run has a newer token anyway.
// `run_started_at` is cleared because the run never happened: the scheduled
// sync keys on it, and a run queued (or crawling) when the server stopped
// would otherwise count as a fresh sync and wait a full cycle.
export async function helpinatorExpireStaleRuns(tx: Tx, libraryId?: string): Promise<void> {
  let q = tx
    .updateTable('helpinator_library_sources')
    .set({ status: 'error', run_token: null, run_started_at: null, last_error: 'The last sync was interrupted (the server restarted). Run it again.' })
    .where('status', '=', 'syncing')
    .where(sql<boolean>`coalesce(run_heartbeat_at, run_started_at, created_at) < now() - ${STALE_RUN}::interval`)
  if (libraryId) q = q.where('library_id', '=', libraryId)
  await q.execute()
}

export function helpinatorSyncRunning(sourceId: string): boolean {
  return running.has(sourceId)
}

// Re-embed every page in scope from its stored markdown (no re-fetch), for the
// AI settings pages' "re-embed" after an embedding model change. Per page: a
// short tx reads it, the embedding runs with no tx, a short tx writes — unless
// a crawl changed the page meanwhile (that crawl embedded it already).
export async function helpinatorReindexLibraries(scope: HelpinatorScope, progress?: AiReindexProgress): Promise<{ chunks: number }> {
  const { pages, run } = await scope(async tx => ({
    pages: await tx.selectFrom('helpinator_library_pages').select(['id', 'library_id', 'title', 'content', 'content_hash']).execute(),
    run: await resolveAiEmbedRun(tx)
  }))
  progress?.total(pages.length)
  let chunks = 0
  for (const p of pages) {
    const pieces = chunkPage(p.title, p.content)
    const { vectors, model } = await embed({ run, input: pieces.map(x => x.text) })
    const written = await scope(async (tx) => {
      const now = await tx.selectFrom('helpinator_library_pages').select('content_hash').where('id', '=', p.id).executeTakeFirst()
      if (!now || now.content_hash !== p.content_hash) return 0
      await writeChunks(tx, p.id, p.library_id, pieces, vectors, model)
      return pieces.length
    })
    chunks += written
    progress?.item(written)
  }
  return { chunks }
}

export const HELPINATOR_REINDEXER: AiReindexer = {
  key: 'helpinator.libraries',
  label: 'Helpinator — library pages',
  // Held back = no pgvector, so none of helpinator's tables exist.
  available: async () => !(await isMigrationHeldBack('helpinator')),
  currentModels: async (tx) => {
    const rows = await (tx as Tx).selectFrom('helpinator_library_chunks').select('model').distinct().execute()
    return rows.map(r => r.model)
  },
  unindexedCount: async (tx) => {
    const row = await (tx as Tx)
      .selectFrom('helpinator_library_pages as p')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('p.content', '<>', '')
      .where(({ not, exists, selectFrom }) => not(exists(selectFrom('helpinator_library_chunks as c').select('c.id').whereRef('c.page_id', '=', 'p.id'))))
      .executeTakeFirst()
    return row?.n ?? 0
  },
  run: async (scope, progress) => {
    if (!(await scope(tx => resolveEmbeddingModel(tx)))) return { chunks: 0 }
    return await helpinatorReindexLibraries(scope as HelpinatorScope, progress)
  }
}
