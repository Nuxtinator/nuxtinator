import { sql } from 'kysely'

export default defineEventHandler(async (event) => {
  // Require authentication
  const user = requireAuth(event)

  // Get request body
  const body = await readBody(event)
  const { display_name } = body

  // Validate input
  if (!display_name || typeof display_name !== 'string') {
    throw createError({
      statusCode: 400,
      statusMessage: 'Display name is required'
    })
  }

  const trimmedName = display_name.trim()

  if (trimmedName.length === 0) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Display name cannot be empty'
    })
  }

  if (trimmedName.length > 100) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Display name is too long (max 100 characters)'
    })
  }

  const before = await db.selectFrom('users').select('display_name').where('id', '=', user.userId).executeTakeFirst()

  // Update display name in database
  const updated = await db
    .updateTable('users')
    .set({ display_name: trimmedName, updated: sql`now()` })
    .where('id', '=', user.userId)
    .returning(['id', 'email', 'display_name'])
    .executeTakeFirst()

  if (!updated) {
    throw createError({
      statusCode: 404,
      statusMessage: 'User not found'
    })
  }

  // Log activity
  logEvent({
    eventType: 'PROFILE_NAME_UPDATED',
    tableName: 'users',
    recordId: user.userId,
    userId: user.userId,
    userAgent: getHeader(event, 'user-agent') || undefined,
    metadata: {
      old_name: user.display_name,
      new_name: trimmedName
    }
  })

  if (before?.display_name !== trimmedName) {
    try {
      await useNitroApp().hooks.callHook('user.updated', { userId: user.userId, fields: ['display_name'] })
    } catch (err) {
      console.warn('[hook user.updated] handler threw:', err)
    }
  }

  return {
    success: true,
    user: updated
  }
})
