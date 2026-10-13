import { sql } from 'kysely'
import { withOrgPermission } from '#tenant/server'
import { inviteState } from '#core/server/utils/invites'

// Unaccepted invites into the active org, newest first.
export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, 'org.members.read', async (tx, ctx) => {
    const rows = await tx
      .selectFrom('invites')
      .innerJoin('invite_orgs', 'invite_orgs.invite_id', 'invites.id')
      .select([
        'invites.id as id',
        'invites.email as email',
        'invites.display_name as display_name',
        'invites.created_at as created_at',
        'invites.expires_at as expires_at',
        'invite_orgs.roles as roles',
        sql<string | null>`(SELECT display_name FROM users WHERE users.id = invites.invited_by)`.as('inviter_name')
      ])
      .where('invite_orgs.org_id', '=', ctx.orgId)
      .where('invites.accepted_at', 'is', null)
      .orderBy('invites.created_at', 'desc')
      .execute()

    return {
      invites: rows.map(r => ({
        ...r,
        kind: r.email ? 'email' : 'link',
        status: inviteState({ accepted_at: null, expires_at: r.expires_at })
      }))
    }
  })
})
