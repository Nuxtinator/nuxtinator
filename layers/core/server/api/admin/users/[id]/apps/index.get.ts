import { getRouterParam } from 'h3'
import { db } from '#core/server/utils/database'
import { requireOperatorAdmin } from '#tenant/server'
import { getUserApps } from '../../../../../utils/personal-apps'

// Host admin: every installed personal app with whether it's on for this user
// (`enabled`) and whether that comes from a grant (`granted`), a host group
// (`viaGroup`) or the app's status.
export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'User id is required' })

  const user = await db.selectFrom('users').select('id').where('id', '=', id).executeTakeFirst()
  if (!user) throw createError({ statusCode: 404, statusMessage: 'User not found' })

  const apps = await getUserApps(db, { userId: id })
  return {
    apps: apps.map(a => ({
      id: a.id,
      title: a.title,
      icon: a.icon,
      status: a.status,
      enabled: a.enabled,
      granted: a.granted,
      viaGroup: a.viaGroup
    }))
  }
})
