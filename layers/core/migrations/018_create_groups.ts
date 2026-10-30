import { type Kysely, sql } from 'kysely'

// Named sets of users. A group belongs to the host (`org_id` NULL) or to one
// org; the tenancy layer adds the foreign key to `orgs`. What a group means
// (an audience that only gates apps, or a team whose members see each other)
// comes from the group-mode setting, not from the row.
//
// None of these tables has RLS: who may see a group or its members is decided
// in the handlers (see groups.ts), the same way the users table is.
//
// `app_groups` lists the groups that can open an app, beside `user_apps`'
// per-user grants.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('groups')
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('org_id', 'uuid')
    .addColumn('name', 'text', col => col.notNull())
    .addColumn('archived_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .execute()

  // One name per scope, ignoring case. Host groups share the all-zero scope.
  await sql`
    CREATE UNIQUE INDEX groups_scope_name_key
      ON groups (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name))
  `.execute(db)
  await db.schema.createIndex('groups_org_idx').on('groups').column('org_id').execute()

  await db.schema
    .createTable('group_members')
    .addColumn('group_id', 'uuid', col => col.notNull().references('groups.id').onDelete('cascade'))
    .addColumn('user_id', 'uuid', col => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('added_by', 'uuid', col => col.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('group_members_pkey', ['group_id', 'user_id'])
    .execute()

  await db.schema.createIndex('group_members_user_idx').on('group_members').column('user_id').execute()

  await db.schema
    .createTable('app_groups')
    .addColumn('app_id', 'text', col => col.notNull().references('apps.id').onDelete('cascade'))
    .addColumn('group_id', 'uuid', col => col.notNull().references('groups.id').onDelete('cascade'))
    .addColumn('granted_by', 'uuid', col => col.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('app_groups_pkey', ['app_id', 'group_id'])
    .execute()

  await db.schema.createIndex('app_groups_group_idx').on('app_groups').column('group_id').execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('app_groups').execute()
  await db.schema.dropTable('group_members').execute()
  await db.schema.dropTable('groups').execute()
}
