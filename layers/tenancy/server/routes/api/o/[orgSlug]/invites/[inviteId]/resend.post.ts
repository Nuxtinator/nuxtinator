import { getRouterParam, getHeader } from 'h3'
import { withOrgPermission } from '#tenant/server'
import { logEvent } from '#core/server/utils/activity-logger'
import { renewInvite } from '#core/server/utils/invites'
import { sendTemplateEmail } from '#email'

// Issues a fresh link for an unaccepted invite into the active org. An email
// invite is re-sent; a link invite returns the new URL to share. The old link
// stops working either way.
export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, 'org.members.invite', async (tx, ctx) => {
    const inviteId = getRouterParam(event, 'inviteId')
    if (!inviteId) throw createError({ statusCode: 400, statusMessage: 'inviteId required' })

    const invite = await tx
      .selectFrom('invites')
      .innerJoin('invite_orgs', 'invite_orgs.invite_id', 'invites.id')
      .select(['invites.id as id', 'invites.email as email', 'invites.display_name as display_name'])
      .where('invites.id', '=', inviteId)
      .where('invite_orgs.org_id', '=', ctx.orgId)
      .where('invites.accepted_at', 'is', null)
      .executeTakeFirst()
    if (!invite) throw createError({ statusCode: 404, statusMessage: 'Invite not found' })

    const renewed = await renewInvite(tx, invite.id)

    if (invite.email) {
      const inviter = await tx
        .selectFrom('users')
        .select(['display_name', 'email'])
        .where('id', '=', ctx.userId)
        .executeTakeFirst()
      try {
        await sendTemplateEmail({
          to: invite.email,
          template: 'invite',
          data: {
            userName: invite.display_name ?? undefined,
            inviterName: inviter?.display_name || inviter?.email || 'Someone',
            orgName: ctx.orgName,
            inviteUrl: renewed.url
          }
        })
      } catch (err) {
        console.error('Error sending invite email:', err)
      }
    }

    logEvent({
      eventType: 'org_invite_resent',
      tableName: 'invites',
      recordId: invite.id,
      userId: ctx.userId,
      userAgent: getHeader(event, 'user-agent') || undefined,
      metadata: { orgId: ctx.orgId, email: invite.email }
    }, tx).catch(() => {})

    return { success: true, expires_at: renewed.expiresAt, ...(invite.email ? {} : { url: renewed.url }) }
  })
})
