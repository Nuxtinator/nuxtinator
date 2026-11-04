import { getRouterParam } from 'h3'
import { db } from '#core/server/utils/database'
import { requireOperatorAdmin } from '#tenant/server'
import { logUpdate } from '../../../utils/activity-logger'
import { requireHostGroup } from '../../../utils/admin-groups'
import { renameGroup, setGroupArchived } from '../../../utils/groups'

// Host admin renames a host group, or archives / restores it.
export default defineEventHandler(async (event) => {
  const { userId } = await requireOperatorAdmin(event)
  const group = await requireHostGroup(db, getRouterParam(event, 'id'))
  const body = await readBody(event)

  if (body?.name !== undefined) await renameGroup(db, group.id, body.name)
  if (typeof body?.archived === 'boolean') await setGroupArchived(db, group.id, body.archived)

  logUpdate('groups', group.id, userId, { name: body?.name, archived: body?.archived })
  return { id: group.id }
})
