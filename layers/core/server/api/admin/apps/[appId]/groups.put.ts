import { getRouterParam } from 'h3'
import { db } from '#core/server/utils/database'
import { requireOperatorAdmin } from '#tenant/server'
import { logEvent } from '../../../../utils/activity-logger'
import { getApp } from '../../../../utils/app-settings'
import { setAppGroups } from '../../../../utils/groups'

// Host admin sets which host groups can open an app. For a personal app it
// takes effect while the app's status is 'host_controlled' (or 'available');
// for an org app in single mode it limits the app to those groups' members.
export default defineEventHandler(async (event) => {
  const { userId } = await requireOperatorAdmin(event)
  const appId = getRouterParam(event, 'appId')
  if (!appId) throw createError({ statusCode: 400, statusMessage: 'appId required' })

  const body = await readBody(event)
  const groupIds = body?.groupIds
  if (!Array.isArray(groupIds) || !groupIds.every(id => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id))) {
    throw createError({ statusCode: 400, statusMessage: 'groupIds must be a list of group ids' })
  }

  const app = await getApp(db, appId)
  // Org apps take host groups only in single mode; with tenancy, an org's
  // admins list the org's own groups.
  if (!app?.installed || (app.scope !== 'user' && useRuntimeConfig().public.tenancy)) {
    throw createError({ statusCode: 404, statusMessage: 'App not found' })
  }

  await db.transaction().execute(trx => setAppGroups(trx, { appId, orgId: null, groupIds, grantedBy: userId }))
  logEvent({ eventType: 'admin_app_groups_changed', tableName: 'app_groups', recordId: appId, userId, metadata: { groupIds } }).catch(() => {})
  return { id: appId, groupIds }
})
