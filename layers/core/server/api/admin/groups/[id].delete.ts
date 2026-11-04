import { getRouterParam } from 'h3'
import { db } from '#core/server/utils/database'
import { requireOperatorAdmin } from '#tenant/server'
import { logDelete } from '../../../utils/activity-logger'
import { requireHostGroup } from '../../../utils/admin-groups'
import { deleteGroup } from '../../../utils/groups'

// Host admin deletes a host group. Refused with a 409, listing what uses it,
// while content is limited to the group.
export default defineEventHandler(async (event) => {
  const { userId } = await requireOperatorAdmin(event)
  const group = await requireHostGroup(db, getRouterParam(event, 'id'))
  await deleteGroup(db, group.id)
  logDelete('groups', group.id, userId, { name: group.name })
  return { id: group.id }
})
