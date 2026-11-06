import { getRouterParam } from 'h3'
import { db } from '#core/server/utils/database'
import { requireOperatorAdmin } from '#tenant/server'
import { logUpdate } from '../../../../utils/activity-logger'
import { requireHostGroup } from '../../../../utils/admin-groups'
import { setGroupImage } from '../../../../utils/groups'

// Host admin removes a host group's image.
export default defineEventHandler(async (event) => {
  const { userId } = await requireOperatorAdmin(event)
  const group = await requireHostGroup(db, getRouterParam(event, 'id'))
  await setGroupImage(db, group.id, null)
  logUpdate('groups', group.id, userId, { image: null })
  return { image: null }
})
