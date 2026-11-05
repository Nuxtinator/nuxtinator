import { getRouterParam } from 'h3'
import { adminDb as db } from '#tenant/admin-db'
import { requireHostAdmin } from '#tenant/server'

// Cross-org member listing for host admin. Operates on `adminDb` (BYPASSRLS).
export default defineEventHandler(async (event) => {
  await requireHostAdmin(event)
  const orgId = getRouterParam(event, 'orgId')
  if (!orgId) throw createError({ statusCode: 400, statusMessage: 'orgId required' })

  const rows = await db
    .selectFrom('memberships')
    .innerJoin('users', 'users.id', 'memberships.user_id')
    .select([
      'memberships.id as membership_id',
      'memberships.user_id as user_id',
      'memberships.roles as roles',
      'memberships.created_at as joined_at',
      'users.email as email',
      'users.display_name as display_name',
      'users.avatar as avatar',
      'users.verified as verified'
    ])
    .where('memberships.org_id', '=', orgId)
    .orderBy('users.display_name', 'asc')
    .execute()

  return { members: rows }
})
