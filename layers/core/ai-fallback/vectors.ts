// pgvector helpers shared by every layer that stores embeddings. Pure code, so
// it lives beside the types in core and is re-exported by both the throwing
// `#ai/server` fallback and the real AI layer — consumers import from
// `#ai/server` either way.
//
// A vector is stored in a `vector(AI_EMBED_DIMENSIONS)` column. The literal
// form pgvector accepts is '[0.1,0.2,...]'; `vectorSql()` binds it as a text
// parameter and casts, so no float ever lands in the SQL string unescaped.
import { sql, type Kysely, type RawBuilder, type Transaction } from 'kysely'

// Width of every vector column. A model that cannot produce this many
// dimensions is rejected at setting time.
export const AI_EMBED_DIMENSIONS = 1536

export function toPgVector(v: number[]): string {
  if (v.length !== AI_EMBED_DIMENSIONS) {
    throw new Error(`Expected a ${AI_EMBED_DIMENSIONS}-dimension vector, got ${v.length}`)
  }
  return `[${v.map(n => (Number.isFinite(n) ? n : 0)).join(',')}]`
}

export function vectorSql(v: number[]): RawBuilder<unknown> {
  return sql`${toPgVector(v)}::vector`
}

// `<=>` is pgvector's cosine distance (0 = identical, 2 = opposite). Callers
// ORDER BY it ascending and may filter on it.
export function cosineDistance(column: string, v: number[]): RawBuilder<number> {
  return sql<number>`${sql.ref(column)} <=> ${vectorSql(v)}`
}

// HNSW scans first and filters after: with a selective WHERE (one org's
// libraries in a table shared by every org) the default candidate list
// (ef_search = 40) can be entirely other rows, leaving few or no hits.
// pgvector >= 0.8 can keep scanning until enough rows pass the filter
// (iterative scan); older versions get a wider candidate list instead. Call
// inside the search's transaction, before the query (the settings are LOCAL).
// With relaxed ordering the rows can arrive slightly out of order, so callers
// re-sort by distance.
let iterativeScan: Promise<boolean> | null = null

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function prepareFilteredVectorSearch(tx: Kysely<any> | Transaction<any>): Promise<void> {
  iterativeScan ??= sql<{ v: string | null }>`select extversion as v from pg_extension where extname = 'vector'`
    .execute(tx)
    .then((r) => {
      const [major = 0, minor = 0] = (r.rows[0]?.v ?? '0.0').split('.').map(Number)
      return major > 0 || minor >= 8
    })
    .catch(() => {
      iterativeScan = null
      return false
    })
  if (await iterativeScan) {
    await sql`select set_config('hnsw.iterative_scan', 'relaxed_order', true), set_config('hnsw.ef_search', '100', true)`.execute(tx)
  } else {
    await sql`select set_config('hnsw.ef_search', '400', true)`.execute(tx)
  }
}

// Cosine similarity in JS for the rare in-process case (tests, small merges).
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length && i < b.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
