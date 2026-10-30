import { type Kysely, sql } from 'kysely'

// Every deploy splits DB access into two roles, in single mode as in multi:
//   the owner (DATABASE_URL) — runs migrations
//   app_user (APP_DATABASE_URL) — the application's `db` client, RLS-enforced
//
// Table owners skip RLS, so personal-app policies hold only when `db` connects
// as app_user. The rls-guard middleware refuses requests until it does.
//
// CREATE ROLE / passwords are out of scope for migrations — they're done once
// at provisioning time (see documentation/database-roles.md). This migration
// wires up the GRANTs, so tables created by later migrations grant access to
// app_user too. Idempotent; the same block runs in tenancy_020.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
        GRANT USAGE ON SCHEMA public TO app_user;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
        EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE ' || current_user || '
                 IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE
                 ON TABLES TO app_user';
        EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE ' || current_user || '
                 IN SCHEMA public GRANT USAGE, SELECT
                 ON SEQUENCES TO app_user';
      END IF;
    END
    $$;
  `.execute(db)
}

// Role grants are never revoked by a down-migration: that could lock out an
// active deploy if run by accident.
export async function down(_db: Kysely<unknown>): Promise<void> {}
