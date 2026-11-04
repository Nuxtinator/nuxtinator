import { db } from '../../utils/database'

// `/api/auth/me` returns the user-global identity. Per-org permissions are
// scoped to the active org and live on `/api/o/:slug` (or `useOrgFetch()`).
//
// `is_admin` is included so the client can show / hide host-only links
// (e.g. "Manage organizations" → /admin) without an extra round trip.
export default defineEventHandler(async (event) => {
  const authUser = getAuthUser(event)

  if (!authUser) {
    throw createError({ statusCode: 401, statusMessage: 'Not authenticated' })
  }

  const user = await db
    .selectFrom('users')
    .select(['id', 'email', 'display_name', 'avatar', 'verified', 'is_admin', 'created', 'updated', 'password'])
    .where('id', '=', authUser.userId)
    .executeTakeFirst()

  if (!user) {
    throw createError({ statusCode: 404, statusMessage: 'User not found' })
  }

  const { password, ...rest } = user
  return {
    user: {
      ...rest,
      avatar: user.avatar || null,
      has_password: password !== null,
      permissions: []
    }
  }
})
