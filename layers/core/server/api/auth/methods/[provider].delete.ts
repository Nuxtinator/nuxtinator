import { db } from '../../../utils/database'
import { getAuthProvider, listSignInMethods } from '../../../utils/auth-provider-registry'
import { requireRecentAuth } from '../../../utils/sessions'

// Unlinks a provider identity. Requires a recent re-authentication, and never
// removes the user's last way to sign in.
export default defineEventHandler(async (event) => {
  const user = await requireRecentAuth(event)
  const providerId = getRouterParam(event, 'provider') || ''
  const provider = getAuthProvider(providerId)
  if (!provider) throw createError({ statusCode: 404, statusMessage: 'Unknown sign-in provider' })

  const row = await db.selectFrom('users').select('password').where('id', '=', user.userId).executeTakeFirst()
  if (!row) throw createError({ statusCode: 404, statusMessage: 'User not found' })

  const methods = await listSignInMethods(user.userId, row.password !== null)
  const target = methods.providers.find(p => p.id === providerId)
  if (!target?.linked) throw createError({ statusCode: 404, statusMessage: 'This provider is not linked' })
  if (methods.count <= 1) {
    throw createError({ statusCode: 409, statusMessage: 'You can\'t remove your only way to sign in. Set a password or link another provider first.' })
  }

  await provider.unlink(user.userId)

  logEvent({
    eventType: 'AUTH_PROVIDER_UNLINKED',
    tableName: 'users',
    recordId: user.userId,
    userId: user.userId,
    userAgent: getHeader(event, 'user-agent') || undefined,
    metadata: { provider: providerId }
  })
  return { success: true }
})
