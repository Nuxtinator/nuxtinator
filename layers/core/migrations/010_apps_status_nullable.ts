import { type Kysely, sql } from 'kysely'

// `apps.status` holds only a host-admin override. NULL means "no override":
// the effective status comes from the layer's `registerApp({ defaultStatus })`,
// falling back to 'disabled' (see app-settings.ts `getApps`).
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE apps ALTER COLUMN status DROP DEFAULT`.execute(db)
  await sql`ALTER TABLE apps ALTER COLUMN status DROP NOT NULL`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`UPDATE apps SET status = 'disabled' WHERE status IS NULL`.execute(db)
  await sql`ALTER TABLE apps ALTER COLUMN status SET NOT NULL`.execute(db)
  await sql`ALTER TABLE apps ALTER COLUMN status SET DEFAULT 'default'`.execute(db)
}
