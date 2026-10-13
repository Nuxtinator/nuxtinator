import { getQuery } from 'h3'
import { db } from '../../utils/database'
import { findInviteByToken, getInviteOrgs, inviteState } from '../../utils/invites'

// Public: what an invite link is for, so the accept page can show it. `email`
// is null for shareable link invites.
export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const token = typeof query.token === 'string' ? query.token : ''

  if (!token) {
    throw createError({ statusCode: 400, statusMessage: 'Token is required' })
  }

  const invite = await findInviteByToken(db, token)
  if (!invite) {
    throw createError({ statusCode: 404, statusMessage: 'Invitation not found' })
  }

  const state = inviteState(invite)
  if (state === 'accepted') {
    throw createError({ statusCode: 404, statusMessage: 'Invitation not found' })
  }
  if (state === 'expired') {
    throw createError({ statusCode: 410, statusMessage: 'Invitation has expired' })
  }

  const inviter = invite.invited_by
    ? await db.selectFrom('users').select('display_name').where('id', '=', invite.invited_by).executeTakeFirst()
    : null

  const orgs = (await getInviteOrgs(db, [invite.id])).get(invite.id) ?? []

  return {
    kind: invite.email ? 'email' : 'link',
    email: invite.email,
    display_name: invite.display_name ?? '',
    inviter_name: inviter?.display_name ?? null,
    orgs: orgs.map(o => ({ slug: o.slug, name: o.name }))
  }
})
