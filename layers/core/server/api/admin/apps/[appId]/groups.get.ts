import { getRouterParam } from 'h3'
import { db } from '#core/server/utils/database'
import { requireOperatorAdmin } from '#tenant/server'
import { getApp } from '../../../../utils/app-settings'
import { getAppGroups, listGroups } from '../../../../utils/groups'

// Host admin: the host groups, with whether each can open this personal app.
// Archived groups are listed only while they're still on the app's list.
export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)
  const appId = getRouterParam(event, 'appId')
  if (!appId) throw createError({ statusCode: 400, statusMessage: 'appId required' })

  const app = await getApp(db, appId)
  if (!app?.installed || app.scope !== 'user') {
    throw createError({ statusCode: 404, statusMessage: 'Personal app not found' })
  }

  const [groups, selected] = await Promise.all([listGroups(db, null), getAppGroups(db, appId)])
  const selectedIds = new Set(selected.map(g => g.id))
  return {
    groups: groups
      .filter(g => !g.archived_at || selectedIds.has(g.id))
      .map(g => ({ id: g.id, name: g.name, member_count: g.member_count, archived: !!g.archived_at, selected: selectedIds.has(g.id) }))
  }
})
