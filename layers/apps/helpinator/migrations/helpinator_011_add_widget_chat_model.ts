import type { Kysely } from 'kysely'

// The widget's own chat model. NULL follows the org's `helpinator.chat`
// choice; a model the org can no longer use falls back to that choice too
// (the admin page flags it) and stays stored until someone changes it.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('helpinator_widgets')
    .addColumn('chat_model', 'text')
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('helpinator_widgets').dropColumn('chat_model').execute()
}
