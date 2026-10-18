import { readBody, getRouterParam, getHeader } from 'h3'
import { db } from '#core/server/utils/database'
import { requireOperatorAdmin } from '#tenant/server'
import { logEvent } from '../../../../../utils/activity-logger'
import { getApp } from '../../../../../utils/app-settings'
import { setUserAppGrant } from '../../../../../utils/personal-apps'

// Host admin turns a personal app on (`granted: true`) or off for one user.
// An app whose status is 'default' stays on for them either way.
export default defineEventHandler(async (event) => {
  const admin = await requireOperatorAdmin(event)
  const id = getRouterParam(event, 'id')
  const appId = getRouterParam(event, 'appId')
  if (!id || !appId) throw createError({ statusCode: 400, statusMessage: 'User id and app id are required' })

  const body = await readBody(event)
  if (typeof body?.granted !== 'boolean') {
    throw createError({ statusCode: 400, statusMessage: 'granted must be a boolean' })
  }

  const app = await getApp(db, appId)
  if (!app?.installed || app.scope !== 'user') {
    throw createError({ statusCode: 404, statusMessage: 'Personal app not found' })
  }
  const user = await db.selectFrom('users').select('id').where('id', '=', id).executeTakeFirst()
  if (!user) throw createError({ statusCode: 404, statusMessage: 'User not found' })

  await setUserAppGrant(db, { userId: id, appId, granted: body.granted, grantedBy: admin.userId })

  logEvent({
    eventType: body.granted ? 'admin_user_app_granted' : 'admin_user_app_revoked',
    tableName: 'user_apps',
    recordId: id,
    userId: admin.userId,
    userAgent: getHeader(event, 'user-agent') || undefined,
    metadata: { appId }
  }).catch(() => {})

  return { id: appId, granted: body.granted }
})
