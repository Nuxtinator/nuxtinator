import { db } from '../../../utils/database'
import { listSignInMethods } from '../../../utils/auth-provider-registry'

// The current user's sign-in methods (password + linked providers).
export default defineEventHandler(async (event) => {
  const user = requireAuth(event)
  const row = await db.selectFrom('users').select('password').where('id', '=', user.userId).executeTakeFirst()
  if (!row) throw createError({ statusCode: 404, statusMessage: 'User not found' })
  return await listSignInMethods(user.userId, row.password !== null)
})
