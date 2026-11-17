import { type Kysely, sql } from 'kysely'

// Core's mail tables name the org a row belongs to (NULL for the host). The
// foreign keys can only exist once `orgs` does; deleting an org deletes its
// mail accounts, domains, routes, suppressions and outbox rows.
const TABLES = ['mail_accounts', 'mail_domains', 'mail_stream_routes', 'mail_suppressions', 'mail_outbox']

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const table of TABLES) {
    await sql`
      ALTER TABLE ${sql.table(table)}
        ADD CONSTRAINT ${sql.id(`${table}_org_id_fkey`)} FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE
    `.execute(db)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of TABLES) {
    await sql`ALTER TABLE ${sql.table(table)} DROP CONSTRAINT ${sql.id(`${table}_org_id_fkey`)}`.execute(db)
  }
}
