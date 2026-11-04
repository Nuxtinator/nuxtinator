import { readBody, getRouterParam, getHeader } from 'h3'
import { db } from '#core/server/utils/database'
import { requireOperatorAdmin } from '#tenant/server'
import { logEvent } from '../../../../utils/activity-logger'

// Grants or revokes `users.is_admin`. Only verified accounts can be promoted,
// so an unverified registration squatting someone's email can't become an
// operator. An admin can't revoke their own bit, which also keeps at least one.
export default defineEventHandler(async (event) => {
  const admin = await requireOperatorAdmin(event)

  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'User id is required' })
  }

  const body = await readBody(event)
  if (typeof body?.is_admin !== 'boolean') {
    throw createError({ statusCode: 400, statusMessage: 'is_admin must be a boolean' })
  }
  const next: boolean = body.is_admin

  if (!next && id === admin.userId) {
    throw createError({ statusCode: 400, statusMessage: 'You cannot remove your own host admin access' })
  }

  const changed = await db.transaction().execute(async (trx) => {
    // Locking every admin row serializes concurrent grants/revokes, so two
    // admins revoking each other can't leave the deployment with none.
    const admins = await trx
      .selectFrom('users')
      .select('id')
      .where('is_admin', '=', true)
      .forUpdate()
      .execute()
    if (!admins.some(a => a.id === admin.userId)) {
      throw createError({ statusCode: 403, statusMessage: 'Operator admin required' })
    }

    const target = await trx
      .selectFrom('users')
      .select(['id', 'email', 'verified', 'is_admin'])
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst()
    if (!target) {
      throw createError({ statusCode: 404, statusMessage: 'User not found' })
    }
    if (target.is_admin === next) return null
    if (next && !target.verified) {
      throw createError({ statusCode: 409, statusMessage: 'Verify the user before making them a host admin' })
    }

    await trx
      .updateTable('users')
      .set({ is_admin: next, updated: new Date().toISOString() })
      .where('id', '=', id)
      .execute()
    return target
  })

  if (changed) {
    await logEvent({
      eventType: next ? 'admin_grant_host_admin' : 'admin_revoke_host_admin',
      tableName: 'users',
      recordId: id,
      userId: admin.userId,
      userAgent: getHeader(event, 'user-agent') || undefined,
      metadata: { email: changed.email }
    })
  }

  return { user: { id, is_admin: next } }
})
