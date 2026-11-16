import { sql } from 'kysely'
import type { Expression, SqlBool } from 'kysely'

/**
 * `predicate` applied to the `records_entries` row's ancestors: true when it
 * holds for any of them. Inside the subquery `records_entries` names the
 * ancestor, so a predicate written against the row in scope reads the
 * ancestor unchanged.
 */
export function anyAncestor(predicate: Expression<SqlBool>): Expression<SqlBool> {
  return sql<SqlBool>`exists (
    select 1 from unnest(records_entries.ancestor_ids) as anc(id)
    inner join records_entries on records_entries.id = anc.id
    where ${predicate}
  )`
}
