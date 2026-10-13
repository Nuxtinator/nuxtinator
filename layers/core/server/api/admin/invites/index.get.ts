import { db } from '#core/server/utils/database'
import { requireOperatorAdmin } from '#tenant/server'
import { getInviteOrgs, inviteState } from '../../../utils/invites'

// Host admin: every invite that hasn't been accepted, newest first, with the
// orgs each one grants.
export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)

  const rows = await db
    .selectFrom('invites')
    .leftJoin('users as inviter', 'inviter.id', 'invites.invited_by')
    .select([
      'invites.id as id',
      'invites.email as email',
      'invites.display_name as display_name',
      'invites.created_at as created_at',
      'invites.expires_at as expires_at',
      'invites.accepted_at as accepted_at',
      'inviter.display_name as inviter_name'
    ])
    .where('invites.accepted_at', 'is', null)
    .orderBy('invites.created_at', 'desc')
    .execute()

  const orgs = await getInviteOrgs(db, rows.map(r => r.id))

  return {
    invites: rows.map(({ accepted_at, ...r }) => ({
      ...r,
      kind: r.email ? 'email' : 'link',
      status: inviteState({ accepted_at, expires_at: r.expires_at }),
      orgs: orgs.get(r.id) ?? []
    }))
  }
})
