import { type Kysely, sql } from 'kysely'

// Hierarchies: a record of a type with a parent field (a task's parent task)
// carries its chain of ancestors, root first, in records_entries.ancestor_ids.
// The kernel rewrites the chain when a record moves; the trigger here cuts it
// when an ancestor is deleted, whichever path deletes it.
//
// A hierarchy link is one records_connections row from the child, keyed by
// the parent field. Task links written from the parent's side (`subtasks`)
// are turned around here, a task with several parents keeps one, and loops
// are cut, so every task ends with at most one parent.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE records_entries ADD COLUMN ancestor_ids uuid[] NOT NULL DEFAULT '{}'`.execute(db)
  await sql`CREATE INDEX records_entries_ancestor_ids_idx ON records_entries USING gin (ancestor_ids)`.execute(db)

  // Links stored both ways round keep the child's row.
  await sql`
    DELETE FROM records_connections s
    USING records_entries p
    WHERE p.id = s.from_record_id AND p.record_type = 'task' AND s.field_key = 'subtasks'
      AND (
        s.from_record_id = s.to_record_id
        OR EXISTS (
          SELECT 1 FROM records_connections c
          WHERE c.field_key = 'parent' AND c.from_record_id = s.to_record_id AND c.to_record_id = s.from_record_id
        )
      )
  `.execute(db)
  // Turned around in place, so the row keeps its org.
  await sql`
    UPDATE records_connections s
    SET from_record_id = s.to_record_id, to_record_id = s.from_record_id, field_key = 'parent'
    FROM records_entries p
    WHERE p.id = s.from_record_id AND p.record_type = 'task' AND s.field_key = 'subtasks'
  `.execute(db)
  await sql`
    DELETE FROM records_connections c
    USING records_entries r
    WHERE r.id = c.from_record_id AND r.record_type = 'task' AND c.field_key = 'parent'
      AND (
        c.from_record_id = c.to_record_id
        OR EXISTS (
          SELECT 1 FROM records_connections o
          WHERE o.field_key = 'parent' AND o.from_record_id = c.from_record_id AND o.id < c.id
        )
      )
  `.execute(db)
  // A task that is its own ancestor loses its parent.
  await sql`
    WITH RECURSIVE links AS (
      SELECT c.from_record_id AS child, c.to_record_id AS parent
      FROM records_connections c
      JOIN records_entries r ON r.id = c.from_record_id AND r.record_type = 'task'
      WHERE c.field_key = 'parent'
    ),
    up(start, node, path) AS (
      SELECT child, parent, ARRAY[child] FROM links
      UNION ALL
      SELECT up.start, l.parent, up.path || l.child
      FROM up JOIN links l ON l.child = up.node
      WHERE NOT l.child = ANY(up.path)
    )
    DELETE FROM records_connections c
    WHERE c.field_key = 'parent'
      AND c.from_record_id IN (SELECT start FROM up WHERE node = start)
  `.execute(db)

  await sql`
    WITH RECURSIVE links AS (
      SELECT c.from_record_id AS child, c.to_record_id AS parent
      FROM records_connections c
      JOIN records_entries r ON r.id = c.from_record_id AND r.record_type = 'task'
      WHERE c.field_key = 'parent'
    ),
    chain(id, ancestors) AS (
      SELECT DISTINCT l.parent, ARRAY[]::uuid[]
      FROM links l
      WHERE NOT EXISTS (SELECT 1 FROM links u WHERE u.child = l.parent)
      UNION ALL
      SELECT l.child, chain.ancestors || chain.id
      FROM chain JOIN links l ON l.parent = chain.id
    )
    UPDATE records_entries e SET ancestor_ids = chain.ancestors
    FROM chain
    WHERE e.id = chain.id AND cardinality(chain.ancestors) > 0
  `.execute(db)

  await sql`
    CREATE FUNCTION records_ancestor_deleted_fn() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      UPDATE records_entries
        SET ancestor_ids = ancestor_ids[array_position(ancestor_ids, OLD.id) + 1:]
        WHERE ancestor_ids @> ARRAY[OLD.id];
      RETURN OLD;
    END
    $$
  `.execute(db)
  await sql`
    CREATE TRIGGER records_entries_ancestor_deleted AFTER DELETE ON records_entries
      FOR EACH ROW EXECUTE FUNCTION records_ancestor_deleted_fn()
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS records_entries_ancestor_deleted ON records_entries`.execute(db)
  await sql`DROP FUNCTION IF EXISTS records_ancestor_deleted_fn()`.execute(db)
  await sql`DROP INDEX IF EXISTS records_entries_ancestor_ids_idx`.execute(db)
  await sql`ALTER TABLE records_entries DROP COLUMN ancestor_ids`.execute(db)
}
