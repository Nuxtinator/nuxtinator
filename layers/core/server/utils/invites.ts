import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Kysely, Transaction } from 'kysely'
import { sql } from './database'
import { getSiteUrl } from './site-url'
import type { Database } from '#core/server/database/schema'

// Invitations live in `invites`, never in `users`: the user row is created
// when someone accepts. An invite either names an email address (sent by
// email) or has none (a single-use link the inviter shares). In multi-tenant
// mode `invite_orgs` (tenancy layer) holds the orgs and roles it grants; those
// tables only exist when the tenancy layer is loaded, so every query that
// touches them is gated on the tenancy flag.

type Executor = Kysely<Database> | Transaction<Database>

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface InviteOrgAttachment {
  orgId: string
  roles: string[]
}

export interface InviteRow {
  id: string
  email: string | null
  display_name: string | null
  invited_by: string | null
  created_at: Date
  expires_at: Date
  accepted_at: Date | null
}

export type InviteState = 'valid' | 'expired' | 'accepted'

function tenancyEnabled(): boolean {
  return useRuntimeConfig().public.tenancy === true
}

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function buildInviteUrl(token: string): string {
  return `${getSiteUrl()}/accept-invite?token=${token}`
}

export function inviteState(invite: Pick<InviteRow, 'accepted_at' | 'expires_at'>): InviteState {
  if (invite.accepted_at) return 'accepted'
  return new Date(invite.expires_at).getTime() > Date.now() ? 'valid' : 'expired'
}

export async function createInvite(
  executor: Executor,
  input: {
    email: string | null
    display_name: string | null
    invitedBy: string | null
    orgs: InviteOrgAttachment[]
  }
): Promise<{ id: string, token: string, url: string, expiresAt: Date }> {
  const id = randomUUID()
  const token = randomBytes(24).toString('base64url')
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS)

  await executor
    .insertInto('invites')
    .values({
      id,
      token_hash: hashInviteToken(token),
      email: input.email ? input.email.toLowerCase() : null,
      display_name: input.display_name || null,
      invited_by: input.invitedBy,
      expires_at: expiresAt
    })
    .execute()

  if (input.orgs.length > 0 && tenancyEnabled()) {
    await (executor as any)
      .insertInto('invite_orgs')
      .values(input.orgs.map(o => ({ invite_id: id, org_id: o.orgId, roles: o.roles })))
      .execute()
  }

  return { id, token, url: buildInviteUrl(token), expiresAt }
}

// Issues a fresh token and expiry for an unaccepted invite (the old link stops
// working). Returns the new link.
export async function renewInvite(executor: Executor, inviteId: string): Promise<{ token: string, url: string, expiresAt: Date }> {
  const token = randomBytes(24).toString('base64url')
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS)
  await executor
    .updateTable('invites')
    .set({ token_hash: hashInviteToken(token), expires_at: expiresAt })
    .where('id', '=', inviteId)
    .where('accepted_at', 'is', null)
    .execute()
  return { token, url: buildInviteUrl(token), expiresAt }
}

export async function findInviteByToken(executor: Executor, token: string): Promise<InviteRow | null> {
  if (!token) return null
  const row = await executor
    .selectFrom('invites')
    .select(['id', 'email', 'display_name', 'invited_by', 'created_at', 'expires_at', 'accepted_at'])
    .where('token_hash', '=', hashInviteToken(token))
    .executeTakeFirst()
  return row ?? null
}

// An unaccepted, unexpired invite addressed to `email`, optionally one that
// grants `orgId`.
export async function findPendingInvite(executor: Executor, email: string, orgId?: string): Promise<{ id: string } | null> {
  let q = executor
    .selectFrom('invites')
    .select('invites.id')
    .where(sql`lower(invites.email)`, '=', email.toLowerCase())
    .where('invites.accepted_at', 'is', null)
    .where('invites.expires_at', '>', new Date())
  if (orgId && tenancyEnabled()) {
    q = q.where(sql<boolean>`EXISTS (SELECT 1 FROM invite_orgs io WHERE io.invite_id = invites.id AND io.org_id = ${orgId})`)
  }
  return (await q.executeTakeFirst()) ?? null
}

// Orgs (with roles) an invite grants, keyed by invite id.
export async function getInviteOrgs(
  executor: Executor,
  inviteIds: string[]
): Promise<Map<string, Array<{ id: string, slug: string, name: string, roles: string[] }>>> {
  const out = new Map<string, Array<{ id: string, slug: string, name: string, roles: string[] }>>()
  if (inviteIds.length === 0 || !tenancyEnabled()) return out

  const rows = await (executor as any)
    .selectFrom('invite_orgs')
    .innerJoin('orgs', 'orgs.id', 'invite_orgs.org_id')
    .select([
      'invite_orgs.invite_id as invite_id',
      'invite_orgs.roles as roles',
      'orgs.id as id',
      'orgs.slug as slug',
      'orgs.name as name'
    ])
    .where('invite_orgs.invite_id', 'in', inviteIds)
    .orderBy('orgs.name', 'asc')
    .execute() as Array<{ invite_id: string, roles: string[], id: string, slug: string, name: string }>

  for (const r of rows) {
    const list = out.get(r.invite_id) ?? []
    list.push({ id: r.id, slug: r.slug, name: r.name, roles: r.roles })
    out.set(r.invite_id, list)
  }
  return out
}

export interface AcceptedMembership {
  membershipId: string
  orgId: string
  roles: string[]
  created: boolean
}

// Marks the invite accepted by `userId` and grants its orgs. If the user is
// already in one of those orgs, the invite's roles are added to the ones they
// have. Throws 410 when the invite was accepted concurrently or has expired.
export async function acceptInvite(
  trx: Transaction<Database>,
  inviteId: string,
  userId: string
): Promise<AcceptedMembership[]> {
  const claimed = await trx
    .updateTable('invites')
    .set({ accepted_at: new Date(), accepted_by: userId })
    .where('id', '=', inviteId)
    .where('accepted_at', 'is', null)
    .where('expires_at', '>', new Date())
    .executeTakeFirst()

  if (Number(claimed.numUpdatedRows ?? 0) === 0) {
    throw createError({ statusCode: 410, statusMessage: 'Invitation has already been used or has expired' })
  }

  if (!tenancyEnabled()) return []

  const result = await sql<{ id: string, org_id: string, roles: string[], created: boolean }>`
    INSERT INTO memberships (id, user_id, org_id, roles, created_at, updated_at)
    SELECT gen_random_uuid(), ${userId}, io.org_id, io.roles, now(), now()
      FROM invite_orgs io
     WHERE io.invite_id = ${inviteId}
    ON CONFLICT (user_id, org_id) DO UPDATE
      SET roles = ARRAY(SELECT DISTINCT unnest(memberships.roles || EXCLUDED.roles)),
          updated_at = now()
    RETURNING id, org_id, roles, (xmax = 0) AS created
  `.execute(trx)

  return result.rows.map(r => ({ membershipId: r.id, orgId: r.org_id, roles: r.roles, created: r.created }))
}

// Fires `membership.created` for memberships an accepted invite created. Call
// after the accepting transaction commits.
export async function emitAcceptedMemberships(memberships: AcceptedMembership[], userId: string, invitedBy: string | null) {
  const nitro = useNitroApp()
  for (const m of memberships.filter(m => m.created)) {
    try {
      await nitro.hooks.callHook('membership.created', {
        membershipId: m.membershipId,
        userId,
        orgId: m.orgId,
        roles: m.roles,
        createdByUserId: invitedBy
      })
    } catch (err) {
      console.warn('[hook membership.created] handler threw:', err)
    }
  }
}
