// The records kernel visibility source for shared boards: a record on a
// custom board (one with its own columns, whose cards are placed explicitly)
// is visible to everyone who can open that board — its owner, anyone it is
// shared with while it isn't private, and the whole org when it's org-wide.
// Field-grouped boards keep rank rows in the same table but never grant
// visibility, since nobody put their cards there. The kernel applies this
// only to types whose `boardsGrantVisibility` is not false (contacts opt out).

import { sql, type SqlBool } from 'kysely'
import type { RecordsVisibilitySource } from '#records/server'

export const boardVisibilitySource: RecordsVisibilitySource = {
  id: 'views:custom-boards',
  predicate: (eb, { userId }) => eb.exists(
    eb.selectFrom('views_cards as bc')
      .innerJoin('views_definitions as bv', 'bv.id', 'bc.view_id')
      .select('bc.record_id')
      .whereRef('bc.record_id', '=', 'records_entries.id')
      .where(sql<SqlBool>`bv.definition ? 'columns'`)
      .where(ieb => ieb.or([
        ieb('bv.owner_id', '=', userId),
        ieb('bv.visibility', '=', 'org'),
        ieb.and([
          ieb('bv.visibility', '=', 'shared'),
          ieb.exists(
            ieb.selectFrom('views_shares as bs')
              .select('bs.user_id')
              .whereRef('bs.view_id', '=', 'bv.id')
              .where('bs.user_id', '=', userId)
          )
        ])
      ]))
  )
}
