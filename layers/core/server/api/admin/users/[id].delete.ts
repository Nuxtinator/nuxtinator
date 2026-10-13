import { getRouterParam, getHeader } from 'h3'
import { db } from '#core/server/utils/database'
import { requireOperatorAdmin } from '#tenant/server'
import { logEvent } from '../../../utils/activity-logger'

// Host-admin: delete a user globally. Last-host-admin protection lives here
// so the operator can't lock themselves out — `is_admin` is the lock
// bit, not the (now per-org) `admin` role.
export default defineEventHandler(async (event) => {
  const admin = await requireOperatorAdmin(event)

  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'User id is required' })
  }
  if (id === admin.userId) {
    throw createError({ statusCode: 400, statusMessage: 'You cannot delete your own account' })
  }

  const target = await db
    .selectFrom('users')
    .select(['id', 'email', 'display_name', 'is_admin'])
    .where('id', '=', id)
    .executeTakeFirst()

  if (!target) {
    throw createError({ statusCode: 404, statusMessage: 'User not found' })
  }

  if (target.is_admin) {
    const countRow = await db
      .selectFrom('users')
      .select(eb => eb.fn.count<string>('id').as('count'))
      .where('is_admin', '=', true)
      .executeTakeFirst()
    const hostAdminCount = Number(countRow?.count ?? 0)
    if (hostAdminCount <= 1) {
      throw createError({ statusCode: 409, statusMessage: 'Cannot delete the last host admin' })
    }
  }

  try {
    await useNitroApp().hooks.callHook('user.deleting', { userId: id })
  } catch (err) {
    console.warn('[hook user.deleting] handler threw:', err)
  }

  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('password_reset_requests').where('user_id', '=', id).execute()
    // memberships cascade-delete via the FK ON DELETE CASCADE.
    await trx.deleteFrom('users').where('id', '=', id).execute()
  })

  await logEvent({
    eventType: 'admin_delete_user',
    tableName: 'users',
    recordId: id,
    userId: admin.userId,
    userAgent: getHeader(event, 'user-agent') || undefined,
    metadata: {
      email: target.email,
      display_name: target.display_name,
      is_admin: target.is_admin
    }
  })

  return { success: true }
})
