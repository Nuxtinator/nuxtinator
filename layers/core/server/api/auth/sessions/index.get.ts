import { listUserSessions } from '../../../utils/sessions'

// The signed-in devices for the current user, newest activity first.
export default defineEventHandler(async (event) => {
  const user = requireAuth(event)
  const rows = await listUserSessions(user.userId)
  return {
    sessions: rows.map(r => ({ ...r, current: r.id === user.sid }))
  }
})
