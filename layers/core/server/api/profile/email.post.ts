import bcrypt from 'bcrypt'
import crypto from 'crypto'
import { sql } from 'kysely'

export default defineEventHandler(async (event) => {
  // Require authentication
  const user = requireAuth(event)

  // Get request body
  const body = await readBody(event)
  const { new_email, current_password } = body

  // Validate input
  if (!new_email || typeof new_email !== 'string') {
    throw createError({
      statusCode: 400,
      statusMessage: 'New email is required'
    })
  }

  if (current_password !== undefined && typeof current_password !== 'string') {
    throw createError({
      statusCode: 400,
      statusMessage: 'Current password must be a string'
    })
  }

  const trimmedEmail = new_email.trim().toLowerCase()

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(trimmedEmail)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid email format'
    })
  }

  // Get current user data including password
  const currentUser = await db
    .selectFrom('users')
    .select(['email', 'password'])
    .where('id', '=', user.userId)
    .executeTakeFirst()

  if (!currentUser) {
    throw createError({
      statusCode: 404,
      statusMessage: 'User not found'
    })
  }

  // Check if new email is same as current
  if (trimmedEmail === currentUser.email) {
    throw createError({
      statusCode: 400,
      statusMessage: 'New email must be different from current email'
    })
  }

  // Confirmed by the current password, or by a recent re-authentication for
  // accounts without one.
  if (current_password) {
    // Verify current password
    const isPasswordValid = currentUser.password
      ? await bcrypt.compare(current_password, currentUser.password)
      : false

    if (!isPasswordValid) {
      // Log failed attempt
      logEvent({
        eventType: 'EMAIL_CHANGE_FAILED',
        tableName: 'users',
        recordId: user.userId,
        userId: user.userId,
        userAgent: getHeader(event, 'user-agent') || undefined,
        metadata: {
          reason: 'invalid_password',
          attempted_new_email: trimmedEmail
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

  // Check if new email is already taken by another user
  const existingUser = await db
    .selectFrom('users')
    .select('id')
    .where('email', '=', trimmedEmail)
    .executeTakeFirst()

  if (existingUser) {
    throw createError({
      statusCode: 400,
      statusMessage: 'This email address is already in use'
    })
  }

  // Generate verification token
  const emailChangeToken = crypto.randomUUID()

  // Store pending email and token
  await db
    .updateTable('users')
    .set({
      pending_email: trimmedEmail,
      email_change_token: emailChangeToken,
      updated: sql`now()`
    })
    .where('id', '=', user.userId)
    .execute()

  // Get runtime config for email
  const config = useRuntimeConfig()

  // Send verification email to NEW email address
  try {
    const verificationUrl = `${process.env.APP_URL || 'http://localhost:3002'}/api/auth/verify-email-change?token=${emailChangeToken}`

    await sendTemplateEmail({
      to: trimmedEmail,
      subject: 'Verify Your New Email Address',
      template: 'emailChangeVerification',
      data: {
        userName: user.display_name,
        oldEmail: currentUser.email,
        newEmail: trimmedEmail,
        verificationUrl: verificationUrl
      }
    })

    // Log successful email change request
    logEvent({
      eventType: 'EMAIL_CHANGE_REQUESTED',
      tableName: 'users',
      recordId: user.userId,
      userId: user.userId,
      userAgent: getHeader(event, 'user-agent') || undefined,
      metadata: {
        old_email: currentUser.email,
        new_email: trimmedEmail
      }
    })

    return {
      success: true,
      message: 'Verification email sent to new address'
    }
  } catch (error) {
    console.error('Error sending verification email:', error)

    // Clean up pending email change on error
    await db
      .updateTable('users')
      .set({ pending_email: null, email_change_token: null })
      .where('id', '=', user.userId)
      .execute()

    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to send verification email'
    })
  }
})
