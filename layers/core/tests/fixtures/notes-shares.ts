// The share routes for a test note, mounted at three paths by global-setup.ts.
import { sql } from 'kysely'
import { defineShareHandler } from '#core/server/utils/shares'

export default defineShareHandler({
  appId: 'test-core-notes',
  table: 'test_core_note_shares',
  permission: 'test-core-notes.read' as never,
  label: async (tx, id) => (await sql<{ title: string }>`select title from test_core_notes where id = ${id}::uuid`.execute(tx)).rows[0]?.title ?? null
})
