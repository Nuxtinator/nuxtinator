import bcrypt from 'bcrypt'
import { sql } from 'kysely'

export default defineEventHandler(async (event) => {
  // Require authentication
  const user = requireAuth(event)

  // Get request body
  const body = await readBody(event)
  const { current_password, new_password } = body

  // Validate input
  if (current_password !== undefined && typeof current_password !== 'string') {
    throw createError({
      statusCode: 400,
      statusMessage: 'Current password must be a string'
    })
  }

  if (!new_password || typeof new_password !== 'string') {
    throw createError({
      statusCode: 400,
      statusMessage: 'New password is required'
    })
  }

  if (new_password.length < 8) {
    throw createError({
      statusCode: 400,
      statusMessage: 'New password must be at least 8 characters long'
    })
  }

  if (new_password.length > 128) {
    throw createError({
      statusCode: 400,
      statusMessage: 'New password is too long (max 128 characters)'
    })
  }

  // Get current user password hash
  const current = await db
    .selectFrom('users')
    .select('password')
    .where('id', '=', user.userId)
    .executeTakeFirst()

  if (!current) {
    throw createError({
      statusCode: 404,
      statusMessage: 'User not found'
    })
  }

  // Changing an existing password is confirmed by the current one (or a recent
  // re-authentication); setting a first password on a provider-only account
  // needs a recent re-authentication.
  if (current.password && current_password) {
    // Don't allow same password
    if (current_password === new_password) {
      throw createError({
        statusCode: 400,
        statusMessage: 'New password must be different from current password'
      })
    }

    // Verify current password
    const isCurrentPasswordValid = await bcrypt.compare(current_password, current.password)

    if (!isCurrentPasswordValid) {
      // Log failed password change attempt
      logEvent({
        eventType: 'PASSWORD_CHANGE_FAILED',
        tableName: 'users',
        recordId: user.userId,
        userId: user.userId,
        userAgent: getHeader(event, 'user-agent') || undefined,
        metadata: {
          reason: 'invalid_current_password'
        }
      })

      throw createError({
        statusCode: 401,
        statusMessage: 'Current password is incorrect'
      })
    }
  } else {
    await requireRecentAuth(event)
  }

  // Hash new password
  const saltRounds = 12
  const newPasswordHash = await bcrypt.hash(new_password, saltRounds)

  // Update password in database
  await db
    .updateTable('users')
    .set({ password: newPasswordHash, updated: sql`now()` })
    .where('id', '=', user.userId)
    .execute()

  // Other devices signed in with the old password are signed out.
  await revokeUserSessions(user.userId, user.sid)

  // Log successful password change
  logEvent({
    eventType: 'PASSWORD_CHANGED',
    tableName: 'users',
    recordId: user.userId,
    userId: user.userId,
    userAgent: getHeader(event, 'user-agent') || undefined,
    metadata: { first_password: !current.password }
  })

  return {
    success: true,
    message: 'Password changed successfully'
  }
})
