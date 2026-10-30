import { db } from '#core/server/utils/database'
import { requireAuth } from '#core/server/utils/auth'
import { getHostGroupMode, getUserGroups, listGroupMembers } from '#core/server/utils/groups'

// The caller's host groups. Members are listed only in teams mode; in
// audiences mode a member learns only which groups they're in.
export default defineEventHandler(async (event) => {
  const { userId } = requireAuth(event)
  const [mode, groups] = await Promise.all([getHostGroupMode(db), getUserGroups(db, userId, null)])
  return {
    mode,
    groups: await Promise.all(groups.map(async g => ({
      id: g.id,
      name: g.name,
      archived: !!g.archived_at,
      members: mode === 'teams'
        ? (await listGroupMembers(db, g.id)).map(m => ({ id: m.user_id, display_name: m.display_name, avatar: m.avatar }))
        : undefined
    })))
  }
})
