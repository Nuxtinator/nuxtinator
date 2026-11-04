import type { H3Event } from 'h3'
import { getRouterParam } from 'h3'
import { logEvent } from '#core/server/utils/activity-logger'
import { withOrgContext } from './tenant'

// Whether the actor may edit a member's account-wide profile (avatar etc.).
// An operator admin always may. A holder of `org.members.edit_user` may only
// when this org is the member's only one and the member is not an operator
// admin, since the change shows wherever the account appears.
export function canEditMember(
  actor: { isOperatorAdmin: boolean, hasPermission: boolean },
  target: { isOperatorAdmin: boolean, membershipCount: number }
): boolean {
  if (actor.isOperatorAdmin) return true
  return actor.hasPermission && !target.isOperatorAdmin && target.membershipCount === 1
}

// Authorizes editing the profile of the member in the `userId` route param
// and returns their id.
export async function authorizeMemberEdit(event: H3Event): Promise<string> {
  const targetUserId = getRouterParam(event, 'userId')
  if (!targetUserId) {
    throw createError({ statusCode: 400, statusMessage: 'userId required' })
  }
  return await withOrgContext(event, async (tx, ctx) => {
    const users = await tx
      .selectFrom('users')
      .select(['id', 'is_admin'])
      .where('id', 'in', [ctx.userId, targetUserId])
      .execute()
    const isOperatorAdmin = !!users.find(u => u.id === ctx.userId)?.is_admin
    const hasPermission = ctx.perms.has('org.members.edit_user')
    if (!hasPermission && !isOperatorAdmin) {
      throw createError({ statusCode: 403, statusMessage: 'Permission required: org.members.edit_user' })
    }

    const memberships = await tx
      .selectFrom('memberships')
      .select('org_id')
      .where('user_id', '=', targetUserId)
      .execute()
    if (!memberships.some(m => m.org_id === ctx.orgId)) {
      throw createError({ statusCode: 404, statusMessage: 'Membership not found' })
    }

    const target = { isOperatorAdmin: !!users.find(u => u.id === targetUserId)?.is_admin, membershipCount: memberships.length }
    if (!canEditMember({ isOperatorAdmin, hasPermission }, target)) {
      throw createError({ statusCode: 403, statusMessage: 'This member manages their own profile' })
    }

    return targetUserId
  })
}

// Records a member profile change in this org's audit log.
export async function logMemberEvent(event: H3Event, eventType: string, targetUserId: string): Promise<void> {
  await withOrgContext(event, (tx, ctx) => logEvent({
    eventType,
    tableName: 'users',
    recordId: targetUserId,
    userId: ctx.userId,
    metadata: { orgId: ctx.orgId, targetUserId }
  }, tx)).catch(() => {})
}
