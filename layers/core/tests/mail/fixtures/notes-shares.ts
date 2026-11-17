// The share routes for a core-mail test note.
import { sql } from 'kysely'
import { defineShareHandler } from '#core/server/utils/shares'

export default defineShareHandler({
  appId: 'test-core-mail-notes',
  table: 'test_core_mail_note_shares',
  permission: 'test-core-mail-notes.read' as never,
  label: async (tx, id) => (await sql<{ title: string }>`select title from test_core_mail_notes where id = ${id}::uuid`.execute(tx)).rows[0]?.title ?? null
})
