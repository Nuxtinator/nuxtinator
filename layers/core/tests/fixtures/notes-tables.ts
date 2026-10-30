// The test notes app's tables, created by global-setup.ts with core's share
// table helper the way an app's migration would.
import type postgres from 'postgres'
import { CURRENT_USER_SQL, sharedWithMe, shareTableStatements } from '../../kit/share-tables'

const SPEC = { table: 'test_core_note_shares', resourceTable: 'test_core_notes' }

export async function dropNotesTables(sql: ReturnType<typeof postgres>): Promise<void> {
  await sql.unsafe('DROP TABLE IF EXISTS test_core_note_shares CASCADE')
  await sql.unsafe('DROP FUNCTION IF EXISTS test_core_note_shares_accept_invite(uuid, uuid)')
  await sql.unsafe('DROP FUNCTION IF EXISTS test_core_note_shares_has_member(uuid, uuid)')
  await sql.unsafe('DROP FUNCTION IF EXISTS test_core_note_shares_resource_owner(uuid)')
  await sql.unsafe('DROP TABLE IF EXISTS test_core_notes CASCADE')
}

export async function createNotesTables(sql: ReturnType<typeof postgres>): Promise<void> {
  await dropNotesTables(sql)
  await sql.unsafe(`CREATE TABLE test_core_notes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title text NOT NULL
  )`)
  for (const statement of shareTableStatements(SPEC)) await sql.unsafe(statement)
  await sql.unsafe('ALTER TABLE test_core_notes ENABLE ROW LEVEL SECURITY')
  await sql.unsafe(`CREATE POLICY test_core_notes_read ON test_core_notes FOR SELECT USING (
    owner_id = ${CURRENT_USER_SQL} OR ${sharedWithMe(SPEC, 'test_core_notes.id')}
  )`)
  await sql.unsafe(`CREATE POLICY test_core_notes_write ON test_core_notes FOR ALL
    USING (owner_id = ${CURRENT_USER_SQL}) WITH CHECK (owner_id = ${CURRENT_USER_SQL})`)
}
