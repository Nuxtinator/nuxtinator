// The records kernel visibility source for shared views: a record added by
// hand to a view (views_items) is visible to everyone who can open that view
// — its owner, anyone it is shared with, the members of its teams when it's
// limited to teams, and the whole org when it's org-wide. Views that show every matching record hold no
// items and never grant visibility, since nobody put those records there.
// The kernel applies this only to types whose `boardsGrantVisibility` is not
// false (contacts opt out).

import type { RecordsVisibilitySource } from '#records/server'
import { viewOpenToUser } from './views'

export const boardVisibilitySource: RecordsVisibilitySource = {
  id: 'views:custom-boards',
  predicate: (eb, { userId }) => eb.exists(
    eb.selectFrom('views_items as bi')
      .innerJoin('views_definitions as bv', 'bv.id', 'bi.view_id')
      .select('bi.record_id')
      .whereRef('bi.record_id', '=', 'records_entries.id')
      .where(ieb => ieb.or([
        ieb('bv.owner_id', '=', userId),
        ieb.exists(
          ieb.selectFrom('views_shares as bs')
            .select('bs.user_id')
            .whereRef('bs.view_id', '=', 'bv.id')
            .where('bs.user_id', '=', userId)
        ),
        viewOpenToUser('bv', userId)
      ]))
  )
}
