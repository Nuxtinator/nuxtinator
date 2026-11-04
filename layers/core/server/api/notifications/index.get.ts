// GET /api/notifications?cursor=&limit=
// The caller's global notification feed, newest-first, cursor-paginated.
// In multi mode RLS filters to the org the request carries, plus the caller's
// personal-app notifications, which show in every org; in single mode it's
// user-scoped only.

import { sql } from 'kysely'
import { withOrgContext } from '#tenant/server'
import { getRegisteredApp } from '#core/server/utils/app-registry'

const DEFAULT_LIMIT = 30
const MAX_LIMIT = 100

export default defineEventHandler(async (event) => {
  return await withOrgContext(event, async (tx, ctx) => {
    // Personal-app notifications have no org; their RLS policy shows them to the recipient.
    await sql`select set_config('app.current_user', ${ctx.userId}, true)`.execute(tx)
    const q = getQuery(event)
    const cursor = typeof q.cursor === 'string' ? q.cursor : null
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(q.limit) || DEFAULT_LIMIT))

    let qb = tx
      .selectFrom('notifications as n')
      .leftJoin('users as actor', 'actor.id', 'n.actor_id')
      .select([
        'n.id',
        'n.app_id',
        'n.title',
        'n.body',
        'n.icon',
        'n.link',
        'n.created_at',
        'n.read_at',
        'actor.id as actor_id',
        'actor.display_name as actor_name',
        'actor.avatar as actor_avatar'
      ])
      .where('n.user_id', '=', ctx.userId)
      .orderBy('n.created_at', 'desc')
      .limit(limit + 1)

    if (cursor) qb = qb.where('n.created_at', '<', new Date(cursor))

    const rows = await qb.execute()
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows

    return {
      notifications: page.map(r => ({
        id: r.id,
        app_id: r.app_id,
        title: r.title,
        body: r.body,
        // Fall back to the producing app's launcher icon when the row omits one.
        icon: r.icon ?? getRegisteredApp(r.app_id)?.icon ?? 'i-lucide-bell',
        link: r.link,
        created_at: r.created_at,
        read_at: r.read_at,
        actor: r.actor_id
          ? { id: r.actor_id, display_name: r.actor_name, avatar: r.actor_avatar }
          : null
      })),
      next_cursor: hasMore ? (page[page.length - 1]!.created_at as Date).toISOString() : null
    }
  })
})
