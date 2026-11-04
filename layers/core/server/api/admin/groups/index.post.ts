import { db } from '#core/server/utils/database'
import { requireOperatorAdmin } from '#tenant/server'
import { logCreate } from '../../../utils/activity-logger'
import { createGroup } from '../../../utils/groups'

// Host admin creates a host group.
export default defineEventHandler(async (event) => {
  const { userId } = await requireOperatorAdmin(event)
  const body = await readBody(event)
  const group = await createGroup(db, { orgId: null, name: body?.name })
  logCreate('groups', group.id, userId, { name: body?.name })
  return group
})
