import { db } from '#core/server/utils/database'
import { requireOperatorAdmin } from '#tenant/server'
import { getHostGroupMode, listGroups } from '../../../utils/groups'

// Host admin: the host's own groups, with member counts, and the mode they run in.
export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)
  const [mode, groups] = await Promise.all([getHostGroupMode(db), listGroups(db, null)])
  return { mode, groups }
})
