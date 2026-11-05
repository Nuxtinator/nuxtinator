// The section vector index: chunk → embed → context_section_chunks, run on
// every section save, plus the similarity search over it. Also exported for
// helpinator, whose portfolio-backed libraries read this same index.
//
// Indexing is best-effort: a save must never fail because OpenRouter is down
// or no embedding model is set. Failures leave `index_state = 'stale'` with
// the message in `index_error`; the section page shows a warning and a
// re-embed button. With embeddings not configured the state stays 'none'.
//
// Without pgvector the chunk table doesn't exist (context_013 is held back):
// every entry point here checks `sectionIndexAvailable()` and no-ops.
import { sql, type Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import { isMigrationHeldBack } from '#core/server/utils/migration-status'
import { afterCommit, type TxScope } from '#core/server/utils/after-commit'
import {
  isEmbeddingConfigured,
  resolveAiEmbedRun,
  embed,
  chunkMarkdown,
  vectorSql,
  cosineDistance,
  prepareFilteredVectorSearch,
  resolveEmbeddingModel,
  type AiEmbeddingRun,
  type AiReindexer,
  type AiReindexProgress
} from '#ai/server'
import { teamVisible, type TeamScope } from '#core/server/utils/team-access'
import { getPortfolioSections } from './section-settings'

type Tx = Transaction<Database>

export const CONTEXT_EMBEDDINGS_FEATURE = 'context.embeddings'
export const CONTEXT_REINDEXER_KEY = 'context.sections'

// Chunks include the section title as a first line so a search on the title
// alone still lands, and so the snippet reads naturally.
export async function sectionIndexAvailable(): Promise<boolean> {
  return !(await isMigrationHeldBack('context_013'))
}

function chunkTexts(title: string, content: string): { heading: string, text: string }[] {
  return chunkMarkdown(content).map(c => ({
    heading: c.heading,
    text: `${title}${c.heading ? ` › ${c.heading}` : ''}\n\n${c.text}`
  }))
}

async function setState(tx: Tx, sectionId: string, state: 'none' | 'ok' | 'stale', error: string | null): Promise<void> {
  await tx
    .updateTable('context_sections')
    .set({ index_state: state, index_error: error })
    .where('id', '=', sectionId)
    .execute()
}

function errorMessage(err: unknown): string {
  const e = err as { statusMessage?: string, message?: string }
  return (e?.statusMessage || e?.message || 'Embedding failed').slice(0, 500)
}

type IndexResult = { state: 'none' | 'ok' | 'stale', chunks: number, error: string | null }
type IndexedSection = { id: string, portfolio_id: string, section_key: string, content: string }

// Replace a section's chunks with fresh embeddings of its stored content.
// Never throws for AI failures (state → 'stale'); empty content clears the
// index and reports 'ok'. Three steps through `scope`, so no transaction is
// open during the embedding call: read the section and resolve the run,
// embed, then write — skipped if the content changed meanwhile (that save
// queued its own index run).
export async function indexSectionScoped(scope: TxScope, sectionId: string): Promise<IndexResult> {
  if (!(await sectionIndexAvailable())) return { state: 'none', chunks: 0, error: null }
  const prep = await scope(async (tx): Promise<IndexResult | { section: IndexedSection, run: AiEmbeddingRun, title: string }> => {
    const section = await tx
      .selectFrom('context_sections')
      .select(['id', 'portfolio_id', 'section_key', 'content'])
      .where('id', '=', sectionId)
      .executeTakeFirst()
    if (!section) return { state: 'none', chunks: 0, error: null }
    if (!(await isEmbeddingConfigured(tx))) {
      await setState(tx, section.id, 'none', null)
      return { state: 'none', chunks: 0, error: null }
    }
    try {
      const def = (await getPortfolioSections(tx, section.portfolio_id)).find(d => d.key === section.section_key)
      return { section, run: await resolveAiEmbedRun(tx, CONTEXT_EMBEDDINGS_FEATURE), title: def?.title ?? section.section_key }
    } catch (err) {
      const message = errorMessage(err)
      await setState(tx, section.id, 'stale', message)
      return { state: 'stale', chunks: 0, error: message }
    }
  })
  if ('state' in prep) return prep

  const { section, run } = prep
  const pieces = chunkTexts(prep.title, section.content ?? '')
  let embedded: { vectors: number[][], model: string }
  try {
    embedded = await embed({ run, input: pieces.map(p => p.text) })
  } catch (err) {
    const message = errorMessage(err)
    console.error(`[context] section index failed for ${section.portfolio_id}/${section.section_key}: ${message}`)
    await scope(tx => setState(tx, section.id, 'stale', message))
    return { state: 'stale', chunks: 0, error: message }
  }

  return await scope(async (tx) => {
    const now = await tx.selectFrom('context_sections').select('content').where('id', '=', section.id).executeTakeFirst()
    if (!now || now.content !== section.content) return { state: 'none' as const, chunks: 0, error: null }
    await tx.deleteFrom('context_section_chunks').where('section_id', '=', section.id).execute()
    for (let i = 0; i < pieces.length; i++) {
      await tx
        .insertInto('context_section_chunks')
        .values({
          section_id: section.id,
          portfolio_id: section.portfolio_id,
          ordinal: i,
          heading: pieces[i]!.heading,
          content: pieces[i]!.text,
          embedding: vectorSql(embedded.vectors[i]!),
          model: embedded.model
        })
        .execute()
    }
    await setState(tx, section.id, 'ok', null)
    return { state: 'ok' as const, chunks: pieces.length, error: null }
  })
}

// Index `sectionId` once `tx` commits (inline when `tx` isn't a tracked
// request transaction). Used by every save path.
export async function indexSectionAfterCommit(tx: Tx, sectionId: string): Promise<void> {
  await afterCommit(tx, async scope => void await indexSectionScoped(scope, sectionId))
}

// Every section of a portfolio (or of every portfolio in scope with no id).
// context_sections has no org_id or RLS of its own; the join to
// context_portfolios (RLS-scoped) is what limits the rows to the current org.
// Each section is read, embedded and written in its own short transactions.
export async function reindexSections(scope: TxScope, portfolioId?: string, progress?: AiReindexProgress): Promise<{ chunks: number }> {
  const rows = await scope((tx) => {
    let q = tx
      .selectFrom('context_sections as s')
      .innerJoin('context_portfolios as p', 'p.id', 's.portfolio_id')
      .select('s.id')
    if (portfolioId) q = q.where('s.portfolio_id', '=', portfolioId)
    return q.execute()
  })
  progress?.total(rows.length)
  let chunks = 0
  for (const row of rows) {
    const result = await indexSectionScoped(scope, row.id)
    if (result.state === 'stale') throw createError({ statusCode: 502, statusMessage: result.error ?? 'Embedding failed' })
    chunks += result.chunks
    progress?.item(result.chunks)
  }
  return { chunks }
}

export interface SectionSearchHit {
  portfolio_id: string
  section_id: string
  section_key: string
  heading: string
  snippet: string
  distance: number
}

// Nearest chunks to `query` across `portfolioIds`, collapsed to the best chunk
// per section. `queryVector` lets a caller that already embedded the query
// (helpinator merging two indexes) skip the second embedding call.
// `teamScope` drops portfolios the caller's teams can't see; member-facing
// callers pass it, Helpinator's public bot doesn't.
export async function searchSections(
  tx: Tx,
  opts: { portfolioIds: string[], query?: string, queryVector?: number[], queryModel?: string, limit?: number, teamScope?: TeamScope }
): Promise<SectionSearchHit[]> {
  const limit = opts.limit ?? 8
  if (opts.portfolioIds.length === 0 || !(await sectionIndexAvailable())) return []
  let vector = opts.queryVector
  let model = opts.queryModel
  if (!vector || !model) {
    if (!opts.query?.trim() || !(await isEmbeddingConfigured(tx))) return []
    const embedded = await embed({ tx, feature: CONTEXT_EMBEDDINGS_FEATURE, input: [opts.query] })
    vector = embedded.vectors[0]!
    model = embedded.model
  }
  // Only chunks from the query's model are comparable (a model change leaves
  // old vectors in another space until the re-embed runs).
  await prepareFilteredVectorSearch(tx)
  const rows = await tx
    .selectFrom('context_section_chunks as c')
    .innerJoin('context_sections as s', 's.id', 'c.section_id')
    .select(['c.portfolio_id', 'c.section_id', 's.section_key', 'c.heading', 'c.content'])
    .select(cosineDistance('c.embedding', vector).as('distance'))
    .where('c.portfolio_id', 'in', opts.portfolioIds)
    .$if(!!opts.teamScope, qb => qb
      .innerJoin('context_portfolios as p', 'p.id', 'c.portfolio_id')
      .where(teamVisible(opts.teamScope!, 'context_portfolios', 'p')))
    .where('c.model', '=', model)
    .orderBy(sql`c.embedding <=> ${vectorSql(vector)}`)
    .limit(limit * 3)
    .execute()
  rows.sort((a, b) => Number(a.distance) - Number(b.distance))
  const best = new Map<string, SectionSearchHit>()
  for (const r of rows) {
    if (best.has(r.section_id)) continue
    best.set(r.section_id, {
      portfolio_id: r.portfolio_id,
      section_id: r.section_id,
      section_key: r.section_key,
      heading: r.heading,
      snippet: r.content.slice(0, 300),
      distance: Number(r.distance)
    })
    if (best.size >= limit) break
  }
  return [...best.values()]
}

// Sections in scope with content but no chunks (never indexed).
export async function sectionUnindexedCount(tx: Tx): Promise<number> {
  if (!(await sectionIndexAvailable())) return 0
  const row = await tx
    .selectFrom('context_sections as s')
    .innerJoin('context_portfolios as p', 'p.id', 's.portfolio_id')
    .select(sql<number>`count(*)::int`.as('n'))
    .where('s.content', '<>', '')
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom('context_section_chunks as c').select('c.id').whereRef('c.section_id', '=', 's.id'))))
    .executeTakeFirst()
  return row?.n ?? 0
}

// Distinct embedding models stored in this scope's index.
export async function sectionIndexModels(tx: Tx): Promise<string[]> {
  if (!(await sectionIndexAvailable())) return []
  const rows = await tx.selectFrom('context_section_chunks').select('model').distinct().execute()
  return rows.map(r => r.model)
}

export const CONTEXT_REINDEXER: AiReindexer = {
  key: CONTEXT_REINDEXER_KEY,
  label: 'Context — portfolio sections',
  available: sectionIndexAvailable,
  currentModels: tx => sectionIndexModels(tx as Tx),
  unindexedCount: tx => sectionUnindexedCount(tx as Tx),
  run: async (scope, progress) => {
    // Nothing to do when no model resolves: leave the index as it is.
    if (!(await scope(tx => resolveEmbeddingModel(tx)))) return { chunks: 0 }
    return await reindexSections(scope as TxScope, undefined, progress)
  }
}
