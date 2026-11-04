import { getRouterParam } from 'h3'
import { db } from '#core/server/utils/database'
import { requireOperatorAdmin } from '#tenant/server'
import { logEvent } from '../../../../../utils/activity-logger'
import { requireHostGroup } from '../../../../../utils/admin-groups'
import { addGroupMember } from '../../../../../utils/groups'

// Host admin adds a user to a host group. A no-op when they're already in it.
export default defineEventHandler(async (event) => {
  const admin = await requireOperatorAdmin(event)
  const group = await requireHostGroup(db, getRouterParam(event, 'id'))
  const userId = getRouterParam(event, 'userId')
  const user = userId && /^[0-9a-f-]{36}$/i.test(userId) ? await db.selectFrom('users').select('id').where('id', '=', userId).executeTakeFirst() : undefined
  if (!user) throw createError({ statusCode: 404, statusMessage: 'User not found' })

  await addGroupMember(db, { groupId: group.id, userId: user.id, addedBy: admin.userId })
  logEvent({ eventType: 'admin_group_member_added', tableName: 'group_members', recordId: group.id, userId: admin.userId, metadata: { memberId: user.id } }).catch(() => {})
  return { groupId: group.id, userId: user.id }
})
