import { getRouterParam } from 'h3'
import { db } from '#core/server/utils/database'
import { requireOperatorAdmin } from '#tenant/server'
import { requireHostGroup } from '../../../../../utils/admin-groups'
import { listGroupMembers } from '../../../../../utils/groups'

// Host admin: a host group's members.
export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)
  const group = await requireHostGroup(db, getRouterParam(event, 'id'))
  return { members: await listGroupMembers(db, group.id) }
})
