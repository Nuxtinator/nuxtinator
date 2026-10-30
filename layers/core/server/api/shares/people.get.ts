import { requireAuth } from '#core/server/utils/auth'
import { runAsShareUser, getKnownPeople } from '#core/server/utils/shares'

// The caller's known people, for the share picker: anyone who accepted a share
// from them, or whose share they accepted, in any app.
export default defineEventHandler(async (event) => {
  const { userId } = requireAuth(event)
  return { people: await runAsShareUser(userId, tx => getKnownPeople(tx, userId)) }
})
