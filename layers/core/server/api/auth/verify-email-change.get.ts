import { sql } from 'kysely'
import { getAccountPath, withQueryParams } from '../../utils/account-path'

export default defineEventHandler(async (event) => {
  const accountPath = getAccountPath(event)
  const query = getQuery(event)
  const token = query.token as string

  if (!token) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Verification token is required'
    })
  }

  try {
    // Find user with this email change token
    const user = await db
      .selectFrom('users')
      .select(['id', 'email', 'pending_email', 'email_change_token'])
      .where('email_change_token', '=', token)
      .executeTakeFirst()

    if (!user) {
      // Redirect to the account page with an error message
      return sendRedirect(event, withQueryParams(accountPath, { email_change: 'invalid_token' }))
    }

    if (!user.pending_email) {
      // No pending email change
      return sendRedirect(event, withQueryParams(accountPath, { email_change: 'no_pending' }))
    }

    const oldEmail = user.email
    const newEmail = user.pending_email

    // Check if new email is now taken by someone else (race condition check)
    const existingUser = await db
      .selectFrom('users')
      .select('id')
      .where(sql`lower(email)`, '=', newEmail.toLowerCase())
      .where('id', '!=', user.id)
      .executeTakeFirst()

    if (existingUser) {
      // Clean up pending change
      await db
        .updateTable('users')
        .set({ pending_email: null, email_change_token: null })
        .where('id', '=', user.id)
        .execute()

      return sendRedirect(event, withQueryParams(accountPath, { email_change: 'email_taken' }))
    }

    // Update email and clear pending fields
    await db
      .updateTable('users')
      .set({
        email: newEmail,
        pending_email: null,
        email_change_token: null,
        updated: sql`now()`
      })
      .where('id', '=', user.id)
      .execute()

    // Log successful email change
    logEvent({
      eventType: 'EMAIL_CHANGED',
      tableName: 'users',
      recordId: user.id,
      userId: user.id,
      userAgent: getHeader(event, 'user-agent') || undefined,
      metadata: {
        old_email: oldEmail,
        new_email: newEmail
      }
    })

    try {
      await useNitroApp().hooks.callHook('user.updated', { userId: user.id, fields: ['email'] })
    } catch (err) {
      console.warn('[hook user.updated] handler threw:', err)
    }

    // Redirect to the account page with a success message
    return sendRedirect(event, withQueryParams(accountPath, { email_change: 'success' }))
  } catch (error) {
    console.error('Email change verification error:', error)
    throw createError({
      statusCode: 500,
      statusMessage: 'Email change verification failed'
    })
  }
})
