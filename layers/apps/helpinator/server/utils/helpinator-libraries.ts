// Libraries: the content sets a widget's bot may search and read. CRUD for the
// admin side plus the binding checks widgets use. Kernel-style — every
// function takes the caller's scope `tx` (RLS restricts it to one org).
import { z } from 'zod'
import { sql, type Selectable, type Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { HelpinatorLibraryKind } from '../database/schema'
import { HELPINATOR_UUID_RE } from './helpinator-widgets'
import { helpinatorUrlLooksPublic } from './helpinator-safe-fetch'

type Tx = Transaction<Database>

export type HelpinatorLibraryRow = Selectable<Database['helpinator_libraries']>
export type HelpinatorSourceRow = Selectable<Database['helpinator_library_sources']>
export type HelpinatorPageRow = Selectable<Database['helpinator_library_pages']>

export const HelpinatorLibraryInput = z.object({
  name: z.string().trim().min(1).max(200),
  kind: z.enum(['website', 'portfolio']),
  portfolio_id: z.string().uuid().nullable().optional(),
  description: z.string().max(2000).default('')
})
export type HelpinatorLibraryInputValue = z.infer<typeof HelpinatorLibraryInput>

const HTTP_URL = z.string().trim().max(2000).refine((v) => {
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}, 'Enter an http(s) URL').refine(helpinatorUrlLooksPublic, 'That address is not reachable from the internet')

export const HELPINATOR_MAX_PAGE_MB = 10

export const HelpinatorSourceInput = z.object({
  url: HTTP_URL,
  restrict_to_path: z.boolean().default(true),
  max_pages: z.number().int().min(1).max(1000).default(200),
  // Per-page HTML cap. Linkedom holds the whole page in memory, so it stays
  // bounded; 2 MB covers almost every site.
  max_page_mb: z.number().int().min(1).max(HELPINATOR_MAX_PAGE_MB).default(2)
})
export type HelpinatorSourceInputValue = z.infer<typeof HelpinatorSourceInput>

// Portfolio content is context's to gate: whoever points a library at a
// portfolio, lists portfolios, or newly binds a portfolio library to a
// (public) widget must also hold context.read — helpinator.manage alone would
// otherwise expose every portfolio to anonymous visitors.
export function helpinatorAssertContextRead(ctx: { perms: Set<string> }): void {
  if (!ctx.perms.has('context.read')) {
    throw createError({ statusCode: 403, statusMessage: 'Using a context portfolio needs the context.read permission.' })
  }
}

// For a widget save: portfolio libraries in `nextIds` that weren't already
// bound (`currentIds`) need context.read.
export async function helpinatorAssertCanBind(tx: Tx, ctx: { perms: Set<string> }, nextIds: string[], currentIds: string[] = []): Promise<void> {
  const added = nextIds.filter(id => !currentIds.includes(id))
  if (added.length === 0) return
  const libs = await helpinatorGetLibraries(tx, added)
  if (libs.some(l => l.kind === 'portfolio')) helpinatorAssertContextRead(ctx)
}

async function assertPortfolio(tx: Tx, kind: HelpinatorLibraryKind, portfolioId: string | null | undefined): Promise<string | null> {
  if (kind !== 'portfolio') return null
  if (!portfolioId) throw createError({ statusCode: 400, statusMessage: 'A portfolio library needs a portfolio.' })
  const row = await tx.selectFrom('context_portfolios').select('id').where('id', '=', portfolioId).executeTakeFirst()
  if (!row) throw createError({ statusCode: 400, statusMessage: 'Unknown portfolio' })
  return portfolioId
}

export async function helpinatorListLibraries(tx: Tx): Promise<HelpinatorLibraryRow[]> {
  return await tx.selectFrom('helpinator_libraries').selectAll().orderBy('name').execute()
}

export async function helpinatorGetLibrary(tx: Tx, id: string): Promise<HelpinatorLibraryRow | null> {
  if (!HELPINATOR_UUID_RE.test(id)) return null
  return (await tx.selectFrom('helpinator_libraries').selectAll().where('id', '=', id).executeTakeFirst()) ?? null
}

export async function helpinatorGetLibraryOr404(tx: Tx, id: string): Promise<HelpinatorLibraryRow> {
  const row = await helpinatorGetLibrary(tx, id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Library not found' })
  return row
}

// The libraries a widget lists, in the order given. Ids RLS hides are simply
// absent, so a forged binding to another org's library reads as missing.
export async function helpinatorGetLibraries(tx: Tx, ids: string[]): Promise<HelpinatorLibraryRow[]> {
  const valid = ids.filter(id => HELPINATOR_UUID_RE.test(id))
  if (valid.length === 0) return []
  const rows = await tx.selectFrom('helpinator_libraries').selectAll().where('id', 'in', valid).execute()
  const byId = new Map(rows.map(r => [r.id, r]))
  return valid.map(id => byId.get(id)).filter((r): r is HelpinatorLibraryRow => !!r)
}

// Every listed library must exist in this org and the default must be listed.
export async function helpinatorAssertLibraries(tx: Tx, ids: string[], defaultId: string): Promise<HelpinatorLibraryRow[]> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) throw createError({ statusCode: 400, statusMessage: 'Pick at least one library.' })
  if (!unique.includes(defaultId)) throw createError({ statusCode: 400, statusMessage: 'The default library must be one of the chosen libraries.' })
  const rows = await helpinatorGetLibraries(tx, unique)
  if (rows.length !== unique.length) throw createError({ statusCode: 400, statusMessage: 'Unknown library' })
  return rows
}

export async function helpinatorCreateLibrary(tx: Tx, input: HelpinatorLibraryInputValue, userId: string): Promise<HelpinatorLibraryRow> {
  const portfolioId = await assertPortfolio(tx, input.kind, input.portfolio_id)
  return await tx
    .insertInto('helpinator_libraries')
    .values({
      name: input.name,
      kind: input.kind,
      portfolio_id: portfolioId,
      description: input.description.trim(),
      created_by: userId
    })
    .returningAll()
    .executeTakeFirstOrThrow()
}

// Kind is fixed after creation: pages and sources only make sense on a website
// library, and a portfolio pointer only on a portfolio one.
export async function helpinatorUpdateLibrary(tx: Tx, id: string, input: HelpinatorLibraryInputValue): Promise<HelpinatorLibraryRow> {
  const existing = await helpinatorGetLibraryOr404(tx, id)
  if (input.kind !== existing.kind) throw createError({ statusCode: 400, statusMessage: 'A library\'s kind cannot change.' })
  const portfolioId = await assertPortfolio(tx, existing.kind, input.portfolio_id)
  return await tx
    .updateTable('helpinator_libraries')
    .set({ name: input.name, portfolio_id: portfolioId, description: input.description.trim(), updated_at: sql`now()` })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow()
}

// Refused while any widget lists the library: the widget's binding would go
// dangling. Sources, pages and chunks cascade.
export async function helpinatorDeleteLibrary(tx: Tx, id: string): Promise<void> {
  await helpinatorGetLibraryOr404(tx, id)
  const users = await tx
    .selectFrom('helpinator_widgets')
    .select('name')
    .where(sql<boolean>`${sql.ref('library_ids')} @> ARRAY[${id}]::uuid[]`)
    .execute()
  if (users.length) {
    throw createError({
      statusCode: 409,
      statusMessage: `This library is used by ${users.length === 1 ? `the widget "${users[0]!.name}"` : `${users.length} widgets`}. Remove it from them first.`
    })
  }
  await tx.deleteFrom('helpinator_libraries').where('id', '=', id).execute()
}

// --- Sources ---

export async function helpinatorListSources(tx: Tx, libraryId: string): Promise<HelpinatorSourceRow[]> {
  return await tx.selectFrom('helpinator_library_sources').selectAll().where('library_id', '=', libraryId).orderBy('created_at').execute()
}

export async function helpinatorGetSourceOr404(tx: Tx, libraryId: string, sourceId: string): Promise<HelpinatorSourceRow> {
  if (!HELPINATOR_UUID_RE.test(sourceId)) throw createError({ statusCode: 404, statusMessage: 'Source not found' })
  const row = await tx
    .selectFrom('helpinator_library_sources')
    .selectAll()
    .where('id', '=', sourceId)
    .where('library_id', '=', libraryId)
    .executeTakeFirst()
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Source not found' })
  return row
}

export async function helpinatorAddSource(tx: Tx, library: HelpinatorLibraryRow, input: HelpinatorSourceInputValue): Promise<HelpinatorSourceRow> {
  if (library.kind !== 'website') throw createError({ statusCode: 400, statusMessage: 'Only website libraries take URLs.' })
  const url = helpinatorNormalizeUrl(input.url)
  if (!url) throw createError({ statusCode: 400, statusMessage: 'Enter an http(s) URL' })
  const dup = await tx
    .selectFrom('helpinator_library_sources')
    .select('id')
    .where('library_id', '=', library.id)
    .where('url', '=', url)
    .executeTakeFirst()
  if (dup) throw createError({ statusCode: 409, statusMessage: 'That URL is already in this library.' })
  // A concurrent add of the same URL lands on the unique key: same 409.
  const row = await tx
    .insertInto('helpinator_library_sources')
    .values({ library_id: library.id, url, restrict_to_path: input.restrict_to_path, max_pages: input.max_pages, max_page_mb: input.max_page_mb })
    .onConflict(oc => oc.columns(['library_id', 'url']).doNothing())
    .returningAll()
    .executeTakeFirst()
  if (!row) throw createError({ statusCode: 409, statusMessage: 'That URL is already in this library.' })
  return row
}

export async function helpinatorUpdateSource(tx: Tx, source: HelpinatorSourceRow, input: Pick<HelpinatorSourceInputValue, 'restrict_to_path' | 'max_pages'> & { max_page_mb?: number }): Promise<HelpinatorSourceRow> {
  return await tx
    .updateTable('helpinator_library_sources')
    .set({ restrict_to_path: input.restrict_to_path, max_pages: input.max_pages, max_page_mb: input.max_page_mb ?? source.max_page_mb })
    .where('id', '=', source.id)
    .returningAll()
    .executeTakeFirstOrThrow()
}

export async function helpinatorDeleteSource(tx: Tx, source: HelpinatorSourceRow): Promise<void> {
  // Pages (and their chunks) cascade off the source.
  await tx.deleteFrom('helpinator_library_sources').where('id', '=', source.id).execute()
}

// --- Pages ---

export async function helpinatorListPages(tx: Tx, libraryId: string, opts: { limit: number, offset: number, sourceId?: string }) {
  let q = tx
    .selectFrom('helpinator_library_pages')
    .select(['id', 'source_id', 'url', 'title', 'bytes', 'fetched_at'])
    .where('library_id', '=', libraryId)
  if (opts.sourceId) q = q.where('source_id', '=', opts.sourceId)
  const rows = await q.orderBy('url').limit(opts.limit + 1).offset(opts.offset).execute()
  return { pages: rows.slice(0, opts.limit), hasMore: rows.length > opts.limit }
}

export async function helpinatorGetPageOr404(tx: Tx, libraryId: string, pageId: string): Promise<HelpinatorPageRow> {
  if (!HELPINATOR_UUID_RE.test(pageId)) throw createError({ statusCode: 404, statusMessage: 'Page not found' })
  const row = await tx
    .selectFrom('helpinator_library_pages')
    .selectAll()
    .where('id', '=', pageId)
    .where('library_id', '=', libraryId)
    .executeTakeFirst()
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Page not found' })
  return row
}

// --- Stats ---

export interface HelpinatorLibraryStats {
  pages: number
  chunks: number
  bytes: number
  // Distinct embedding models in this library's chunks (>1 or ≠ current = stale).
  models: string[]
}

export async function helpinatorLibraryStats(tx: Tx, libraryId: string): Promise<HelpinatorLibraryStats> {
  const [pages, chunks] = await Promise.all([
    tx.selectFrom('helpinator_library_pages')
      .select([sql<number>`count(*)::int`.as('n'), sql<number>`coalesce(sum(bytes), 0)::int`.as('bytes')])
      .where('library_id', '=', libraryId)
      .executeTakeFirstOrThrow(),
    tx.selectFrom('helpinator_library_chunks')
      .select(['model', sql<number>`count(*)::int`.as('n')])
      .where('library_id', '=', libraryId)
      .groupBy('model')
      .execute()
  ])
  return {
    pages: pages.n,
    bytes: pages.bytes,
    chunks: chunks.reduce((n, r) => n + r.n, 0),
    models: chunks.map(r => r.model).sort()
  }
}

// --- URLs ---

const TRACKING_PARAM_RE = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$)/i

// Canonical form for dedupe: lowercase host, no hash, no tracking params,
// no trailing slash except the root. Returns null for a non-http(s) URL.
export function helpinatorNormalizeUrl(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  u.hash = ''
  u.hostname = u.hostname.toLowerCase()
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAM_RE.test(key)) u.searchParams.delete(key)
  }
  u.searchParams.sort()
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1)
  return u.toString()
}
