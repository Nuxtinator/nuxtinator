// The records kernel visibility source for hand-picked views: a record on a
// hand-picked view (views_items) is shared with everyone who can open that
// view — its owner, the people and teams it is shared with, and the whole org
// when it's org-wide — and those at 'edit' can edit it. Views that show every
// matching record hold no items and never share anything. The kernel applies
// this only to types whose `boardsGrantVisibility` is not false (contacts opt
// out).

import type { RecordsShareVia, RecordsVisibilitySource } from '#records/server'
import { viewEditableByUser, viewOpenToUser } from './views'

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
  ),
  editPredicate: (eb, { userId }) => eb.exists(
    eb.selectFrom('views_items as ei')
      .innerJoin('views_definitions as ev', 'ev.id', 'ei.view_id')
      .select('ei.record_id')
      .whereRef('ei.record_id', '=', 'records_entries.id')
      .where(viewEditableByUser('ev', userId))
  ),
  describe: async (tx, ctx, recordId) => {
    const userId = ctx.userId
    let query = tx
      .selectFrom('views_items as i')
      .innerJoin('views_definitions as v', 'v.id', 'i.view_id')
      .select(['v.id', 'v.name', 'v.visibility', 'v.org_level'])
      .where('i.record_id', '=', recordId)
    // Lists only the views the caller can open (the getViewAccess rule), so
    // private views' names and audiences stay private.
    if (!ctx.roles.includes('admin')) {
      query = query.where(eb => eb.or([
        eb('v.owner_id', '=', userId),
        eb.exists(
          eb.selectFrom('views_shares as vs')
            .select('vs.user_id')
            .whereRef('vs.view_id', '=', 'v.id')
            .where('vs.user_id', '=', userId)
        ),
        viewOpenToUser('v', userId)
      ]))
    }
    const views = await query.orderBy('v.name').execute()
    const out: RecordsShareVia[] = []
    for (const v of views) {
      const audience: RecordsShareVia['audience'] = []
      if (v.visibility === 'org') {
        audience.push({ kind: 'everyone', name: 'Everyone', level: v.org_level ?? 'view' })
      } else if (v.visibility === 'teams') {
        const teams = await tx
          .selectFrom('views_teams as t')
          .innerJoin('groups as g', 'g.id', 't.group_id')
          .select(['g.name', 't.level'])
          .where('t.container_id', '=', v.id)
          .orderBy('g.name')
          .execute()
        for (const t of teams) audience.push({ kind: 'team', name: t.name, level: t.level ?? 'view' })
      }
      const people = await tx
        .selectFrom('views_shares as s')
        .innerJoin('users as u', 'u.id', 's.user_id')
        .select(['u.display_name', 's.level'])
        .where('s.view_id', '=', v.id)
        .orderBy('u.display_name')
        .execute()
      for (const p of people) audience.push({ kind: 'user', name: p.display_name, level: p.level })
      out.push({ sourceId: 'views:custom-boards', label: v.name, path: `/views/${v.id}`, audience })
    }
    return out
  }
}
