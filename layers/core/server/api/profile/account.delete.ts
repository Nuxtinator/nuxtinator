import bcrypt from 'bcrypt'

export default defineEventHandler(async (event) => {
  // Require authentication
  const user = requireAuth(event)

  // Confirmed either by the password in the body or, for accounts without a
  // password (or a client that already stepped up), a recent re-authentication.
  const body = await readBody(event).catch(() => null) as { password?: unknown } | null
  const password = typeof body?.password === 'string' ? body.password : ''

  // Get current user password hash
  const current = await db
    .selectFrom('users')
    .select(['password', 'email'])
    .where('id', '=', user.userId)
    .executeTakeFirst()

  if (!current) {
    throw createError({
      statusCode: 404,
      statusMessage: 'User not found'
    })
  }

  if (password) {
    // Verify password
    const isPasswordValid = current.password
      ? await bcrypt.compare(password, current.password)
      : false

    if (!isPasswordValid) {
      // Log failed account deletion attempt
      logEvent({
        eventType: 'ACCOUNT_DELETE_FAILED',
        tableName: 'users',
        recordId: user.userId,
        userId: user.userId,
        userAgent: getHeader(event, 'user-agent') || undefined,
        metadata: {
          reason: 'invalid_password'
        }
      })

      throw createError({
        statusCode: 401,
        statusMessage: 'Password is incorrect'
      })
    }
  } else {
    await requireRecentAuth(event)
  }

  // Layers holding credentials at third parties (e.g. a provider's refresh
  // token) revoke them before the user row and its cascades disappear.
  try {
    await useNitroApp().hooks.callHook('user.deleting', { userId: user.userId })
  } catch (err) {
    console.warn('[hook user.deleting] handler threw:', err)
  }

  // Delete related data in correct order (foreign key constraints)
  await db.transaction().execute(async (trx) => {
    // 1. Delete password reset requests
    await trx
      .deleteFrom('password_reset_requests')
      .where('user_id', '=', user.userId)
      .execute()

    // 2. Delete activity logs for this user
    await trx
      .deleteFrom('activity_logs')
      .where('user_id', '=', user.userId)
      .execute()

    // 3. Delete the user
    await trx
      .deleteFrom('users')
      .where('id', '=', user.userId)
      .execute()
  })

  // Log account deletion (this log entry won't have user_id since we deleted it)
  logEvent({
    eventType: 'ACCOUNT_DELETED',
    tableName: 'users',
    recordId: user.userId,
    userAgent: getHeader(event, 'user-agent') || undefined,
    metadata: {
      email: current.email
    }
  })

  // Clear session cookies (the session rows went with the user)
  clearSessionCookies(event)

  return {
    success: true,
    message: 'Account deleted successfully'
  }
})
