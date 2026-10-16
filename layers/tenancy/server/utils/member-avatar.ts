import type { H3Event } from 'h3'
import { getRouterParam } from 'h3'
import { logEvent } from '#core/server/utils/activity-logger'
import { withOrgContext } from './tenant'

// Who may change a member's avatar from the org's members page: holders of
// `org.members.edit_avatar` in this org, or an operator admin. The avatar is
// account-wide, so only an operator admin may change an operator admin's.
// Returns the target user's id.
export async function authorizeMemberAvatarEdit(event: H3Event): Promise<string> {
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
    const actorIsAdmin = !!users.find(u => u.id === ctx.userId)?.is_admin
    if (!ctx.perms.has('org.members.edit_avatar') && !actorIsAdmin) {
      throw createError({ statusCode: 403, statusMessage: 'Permission required: org.members.edit_avatar' })
    }

    const membership = await tx
      .selectFrom('memberships')
      .select('id')
      .where('user_id', '=', targetUserId)
      .where('org_id', '=', ctx.orgId)
      .executeTakeFirst()
    if (!membership) {
      throw createError({ statusCode: 404, statusMessage: 'Membership not found' })
    }

    if (users.find(u => u.id === targetUserId)?.is_admin && !actorIsAdmin) {
      throw createError({ statusCode: 403, statusMessage: 'Only an operator admin can change an operator admin\'s avatar' })
    }

    return targetUserId
  })
}

// Records an avatar change in this org's audit log.
export async function logMemberAvatarEvent(
  event: H3Event,
  eventType: 'org_member_avatar_updated' | 'org_member_avatar_removed',
  targetUserId: string
): Promise<void> {
  await withOrgContext(event, (tx, ctx) => logEvent({
    eventType,
    tableName: 'users',
    recordId: targetUserId,
    userId: ctx.userId,
    metadata: { orgId: ctx.orgId, targetUserId }
  }, tx)).catch(() => {})
}
