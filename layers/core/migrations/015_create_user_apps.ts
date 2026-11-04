import { type Kysely, sql } from 'kysely'

// Per-user grants for personal apps (`registerApp({ scope: 'user' })`). A row
// means a host admin turned the app on for that user; an app whose status is
// 'default' is on for everyone without one. Same in both modes: personal apps
// have no org, so neither table gets an org_id.
//
// `invite_apps` holds the personal apps an invite grants, the way tenancy's
// `invite_orgs` holds its orgs; accepting the invite turns them into
// `user_apps` rows.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('user_apps')
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('user_id', 'uuid', col => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('app_id', 'text', col => col.notNull().references('apps.id').onDelete('cascade'))
    .addColumn('granted_by', 'uuid', col => col.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('user_apps_user_app_key', ['user_id', 'app_id'])
    .execute()

  await db.schema
    .createTable('invite_apps')
    .addColumn('invite_id', 'uuid', col => col.notNull().references('invites.id').onDelete('cascade'))
    .addColumn('app_id', 'text', col => col.notNull().references('apps.id').onDelete('cascade'))
    .addPrimaryKeyConstraint('invite_apps_pkey', ['invite_id', 'app_id'])
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('invite_apps').execute()
  await db.schema.dropTable('user_apps').execute()
}
