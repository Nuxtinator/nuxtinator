import { getRouterParam, getHeader } from 'h3'
import { db } from '#core/server/utils/database'
import { requireOperatorAdmin } from '#tenant/server'
import { requireAuth } from '../../../../utils/auth'
import { renewInvite } from '../../../../utils/invites'
import { sendTemplateEmail } from '#email'

// Host admin: issue a fresh link for an unaccepted invite. An email invite is
// re-sent to its address; a link invite returns the new URL to share (the old
// link stops working either way).
export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)
  const admin = requireAuth(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Invite id is required' })

  const invite = await db
    .selectFrom('invites')
    .select(['id', 'email', 'display_name', 'accepted_at'])
    .where('id', '=', id)
    .executeTakeFirst()
  if (!invite || invite.accepted_at) {
    throw createError({ statusCode: 404, statusMessage: 'Invite not found' })
  }

  const renewed = await renewInvite(db, invite.id)

  if (invite.email) {
    try {
      await sendTemplateEmail({
        to: invite.email,
        template: 'invite',
        data: {
          userName: invite.display_name ?? undefined,
          inviterName: admin.display_name,
          inviteUrl: renewed.url
        }
      })
    } catch (err) {
      console.error('Error sending invite email:', err)
    }
  }

  await logEvent({
    eventType: 'invite_resent',
    tableName: 'invites',
    recordId: invite.id,
    userId: admin.userId,
    userAgent: getHeader(event, 'user-agent') || undefined,
    metadata: { email: invite.email }
  })

  return { success: true, expires_at: renewed.expiresAt, ...(invite.email ? {} : { url: renewed.url }) }
})
