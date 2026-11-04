import type { Kysely } from 'kysely'
import { sql } from 'kysely'

// Vector index over library pages (see `#ai/server` chunkMarkdown). Same shape
// as context_section_chunks; `model` records the embedding model so a change
// can be detected and the index rebuilt. Needs pgvector: helpinator's
// nuxt.config declares it, so without the extension core's runner holds back
// every helpinator_* migration (the guard below covers a runner that doesn't).
export async function up(db: Kysely<unknown>): Promise<void> {
  const present = await sql<{ n: number }>`select count(*)::int as n from pg_extension where extname = 'vector'`.execute(db)
  if (!present.rows[0]?.n) {
    try {
      await sql`CREATE EXTENSION vector`.execute(db)
    } catch (err) {
      throw new Error(`pgvector is not installed and this role may not create it. Run "CREATE EXTENSION vector;" as a superuser, then restart. (${(err as Error).message})`, { cause: err })
    }
  }

  await db.schema
    .createTable('helpinator_library_chunks')
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('page_id', 'uuid', col => col.notNull().references('helpinator_library_pages.id').onDelete('cascade'))
    .addColumn('library_id', 'uuid', col => col.notNull())
    .addColumn('ordinal', 'integer', col => col.notNull())
    .addColumn('heading', 'text', col => col.notNull().defaultTo(''))
    .addColumn('content', 'text', col => col.notNull())
    .addColumn('embedding', sql`vector(1536)`, col => col.notNull())
    .addColumn('model', 'text', col => col.notNull())
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('helpinator_library_chunks_page_ordinal_uq', ['page_id', 'ordinal'])
    .execute()

  await sql`
    CREATE INDEX helpinator_library_chunks_embedding_idx
      ON helpinator_library_chunks USING hnsw (embedding vector_cosine_ops)
  `.execute(db)
  await db.schema
    .createIndex('helpinator_library_chunks_library_idx')
    .on('helpinator_library_chunks')
    .column('library_id')
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('helpinator_library_chunks').ifExists().execute()
}
