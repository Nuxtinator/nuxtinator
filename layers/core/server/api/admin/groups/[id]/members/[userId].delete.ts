import { getRouterParam } from 'h3'
import { db } from '#core/server/utils/database'
import { requireOperatorAdmin } from '#tenant/server'
import { logEvent } from '../../../../../utils/activity-logger'
import { requireHostGroup } from '../../../../../utils/admin-groups'
import { removeGroupMember } from '../../../../../utils/groups'

// Host admin removes a user from a host group.
export default defineEventHandler(async (event) => {
  const admin = await requireOperatorAdmin(event)
  const group = await requireHostGroup(db, getRouterParam(event, 'id'))
  const userId = getRouterParam(event, 'userId')
  if (!userId) throw createError({ statusCode: 400, statusMessage: 'userId required' })

  await removeGroupMember(db, group.id, userId)
  logEvent({ eventType: 'admin_group_member_removed', tableName: 'group_members', recordId: group.id, userId: admin.userId, metadata: { memberId: userId } }).catch(() => {})
  return { groupId: group.id, userId }
})
