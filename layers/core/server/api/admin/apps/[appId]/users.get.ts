import { getQuery, getRouterParam } from 'h3'
import { db, sql } from '#core/server/utils/database'
import { requireOperatorAdmin } from '#tenant/server'
import { getApp } from '../../../../utils/app-settings'
import { resolveUserAppEnabled } from '../../../../utils/personal-apps'

const LIMIT = 100

// Host admin: users with whether a personal app is on for them. Users with a
// grant come first; `q` filters by name or email. Toggling goes through
// PUT /api/admin/users/:id/apps/:appId.
export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)
  const appId = getRouterParam(event, 'appId')
  if (!appId) throw createError({ statusCode: 400, statusMessage: 'appId required' })

  const app = await getApp(db, appId)
  if (!app?.installed || app.scope !== 'user') {
    throw createError({ statusCode: 404, statusMessage: 'Personal app not found' })
  }

  const q = typeof getQuery(event).q === 'string' ? (getQuery(event).q as string).trim() : ''
  const pattern = q ? `%${q}%` : null
  const granted = sql<boolean>`exists (select 1 from user_apps ua where ua.user_id = users.id and ua.app_id = ${appId})`

  const base = db.selectFrom('users')
    .$if(!!pattern, qb => qb.where(eb => eb.or([
      eb('users.display_name', 'ilike', pattern!),
      eb('users.email', 'ilike', pattern!)
    ])))

  const [rows, totalRow] = await Promise.all([
    base
      .select(['users.id', 'users.display_name', 'users.email', 'users.avatar', granted.as('granted')])
      .orderBy(granted, 'desc')
      .orderBy('users.display_name', 'asc')
      .limit(LIMIT)
      .execute(),
    base.select(eb => eb.fn.countAll<string>().as('count')).executeTakeFirst()
  ])

  return {
    status: app.status,
    total: Number(totalRow?.count ?? 0),
    users: rows.map(r => ({
      id: r.id,
      display_name: r.display_name,
      email: r.email,
      avatar: r.avatar,
      granted: r.granted,
      enabled: resolveUserAppEnabled(app.status, r.granted)
    }))
  }
})
