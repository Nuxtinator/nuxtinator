// GET /api/notifications/unread-counts
// Unread totals for the caller: the global count (bell badge) plus a per-app
// breakdown (AppRail tile badges). Active-org scoped via RLS in multi mode,
// plus the caller's personal-app notifications.

import { sql } from 'kysely'
import { withOrgContext } from '#tenant/server'

export default defineEventHandler(async (event) => {
  return await withOrgContext(event, async (tx, ctx) => {
    // Personal-app notifications have no org; their RLS policy shows them to the recipient.
    await sql`select set_config('app.current_user', ${ctx.userId}, true)`.execute(tx)
    const rows = await tx
      .selectFrom('notifications')
      .select(eb => ['app_id', eb.fn.countAll<string>().as('c')])
      .where('user_id', '=', ctx.userId)
      .where('read_at', 'is', null)
      .groupBy('app_id')
      .execute()

    const byApp: Record<string, number> = {}
    let total = 0
    for (const r of rows) {
      const n = Number(r.c)
      byApp[r.app_id] = n
      total += n
    }

    return { total, byApp }
  })
})
