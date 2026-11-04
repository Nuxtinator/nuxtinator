import bcrypt from 'bcrypt'

export default defineEventHandler(async (event) => {
  const { token, password, confirmPassword } = await readBody(event)

  // Validate inputs
  if (!token || !password || !confirmPassword) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Token, password, and confirmation are required'
    })
  }

  // Validate passwords match
  if (password !== confirmPassword) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Passwords do not match'
    })
  }

  // Validate password length
  if (password.length < 6) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Password must be at least 6 characters'
    })
  }

  // Sanitize token
  const sanitizedToken = token.trim().substring(0, 255)

  try {
    // Find valid reset request
    const resetRequest = await db
      .selectFrom('password_reset_requests')
      .selectAll()
      .where('token', '=', sanitizedToken)
      .where('used', '=', false)
      .where('expires', '>', new Date())
      .executeTakeFirst()

    if (!resetRequest) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Invalid or expired reset token'
      })
    }

    // Hash the new password
    const hashedPassword = await bcrypt.hash(password, 12)

    await db.transaction().execute(async (trx) => {
      // Update user's password
      await trx
        .updateTable('users')
        .set({ password: hashedPassword })
        .where('id', '=', resetRequest.user_id)
        .execute()

      // Mark token as used
      await trx
        .updateTable('password_reset_requests')
        .set({ used: true })
        .where('token', '=', sanitizedToken)
        .execute()

      // Clean up old/expired reset requests
      await trx
        .deleteFrom('password_reset_requests')
        .where('user_id', '=', resetRequest.user_id)
        .where(eb =>
          eb.or([
            eb('used', '=', true),
            eb('expires', '<=', new Date())
          ])
        )
        .execute()
    })

    // A reset means the old password may be known to someone else; sign out
    // every device that used it.
    await revokeUserSessions(resetRequest.user_id)

    // Log the password reset
    const userAgent = getHeader(event, 'user-agent') || undefined
    logPasswordReset(resetRequest.user_id, userAgent)

    return {
      success: true,
      message: 'Password reset successfully. You can now log in with your new password.'
    }
  } catch (error: any) {
    // If it's already a createError, throw it as-is
    if (error.statusCode) {
      throw error
    }

    console.error('Error in reset-password endpoint:', error)
    throw createError({
      statusCode: 500,
      statusMessage: 'An error occurred while resetting your password'
    })
  }
})
