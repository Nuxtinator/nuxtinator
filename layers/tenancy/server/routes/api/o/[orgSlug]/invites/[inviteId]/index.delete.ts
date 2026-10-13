import { getRouterParam, getHeader } from 'h3'
import { withOrgPermission } from '#tenant/server'
import { logEvent } from '#core/server/utils/activity-logger'

// Withdraws an unaccepted invite from the active org. An invite that also
// grants other orgs (a host-admin invite) keeps working for those; one left
// with no orgs is deleted.
export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, 'org.members.invite', async (tx, ctx) => {
    const inviteId = getRouterParam(event, 'inviteId')
    if (!inviteId) throw createError({ statusCode: 400, statusMessage: 'inviteId required' })

    const invite = await tx
      .selectFrom('invites')
      .innerJoin('invite_orgs', 'invite_orgs.invite_id', 'invites.id')
      .select('invites.id')
      .where('invites.id', '=', inviteId)
      .where('invite_orgs.org_id', '=', ctx.orgId)
      .where('invites.accepted_at', 'is', null)
      .executeTakeFirst()
    if (!invite) throw createError({ statusCode: 404, statusMessage: 'Invite not found' })

    await tx.deleteFrom('invite_orgs').where('invite_id', '=', inviteId).where('org_id', '=', ctx.orgId).execute()
    const remaining = await tx
      .selectFrom('invite_orgs')
      .select(eb => eb.fn.countAll<string>().as('count'))
      .where('invite_id', '=', inviteId)
      .executeTakeFirst()
    if (Number(remaining?.count ?? 0) === 0) {
      await tx.deleteFrom('invites').where('id', '=', inviteId).execute()
    }

    logEvent({
      eventType: 'org_invite_revoked',
      tableName: 'invites',
      recordId: inviteId,
      userId: ctx.userId,
      userAgent: getHeader(event, 'user-agent') || undefined,
      metadata: { orgId: ctx.orgId }
    }, tx).catch(() => {})

    return { success: true }
  })
})
