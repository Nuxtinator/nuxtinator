import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Kysely, Transaction } from 'kysely'
import { db, sql } from './database'
import { getSiteUrl } from './site-url'
import { getRegisteredApp } from './app-registry'
import { getShareTables } from './share-registry'
import type { Database, InviteKind } from '#core/server/database/schema'

// Invitations live in `invites`, never in `users`: the user row is created
// when someone accepts. An invite either names an email address (sent by
// email) or has none (a single-use link the inviter shares). An admin's invite
// (`kind` 'admin') may grant orgs and personal apps; a share invite (`kind`
// 'share') grants only the pending shares that point at it (see shares.ts),
// and creates an account only while self-registration is on. In multi-tenant
// mode `invite_orgs` (tenancy layer) holds the orgs and roles it grants; those
// tables only exist when the tenancy layer is loaded, so every query that
// touches them is gated on the tenancy flag. `invite_apps` (core, both modes)
// holds the personal apps it grants.

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
  kind: InviteKind
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
    // Personal app ids the invite turns on for whoever accepts it.
    apps?: string[]
    kind?: InviteKind
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
      expires_at: expiresAt,
      ...(input.kind ? { kind: input.kind } : {})
    })
    .execute()

  if (input.orgs.length > 0 && tenancyEnabled()) {
    await (executor as any)
      .insertInto('invite_orgs')
      .values(input.orgs.map(o => ({ invite_id: id, org_id: o.orgId, roles: o.roles })))
      .execute()
  }

  const apps = [...new Set(input.apps ?? [])]
  if (apps.length > 0) {
    // The catalog rows are normally seeded on first request; make sure the FK holds.
    await executor.insertInto('apps').values(apps.map(appId => ({ id: appId }))).onConflict(oc => oc.column('id').doNothing()).execute()
    await executor.insertInto('invite_apps').values(apps.map(appId => ({ invite_id: id, app_id: appId }))).execute()
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
    .select(['id', 'email', 'display_name', 'invited_by', 'created_at', 'expires_at', 'accepted_at', 'kind'])
    .where('token_hash', '=', hashInviteToken(token))
    .executeTakeFirst()
  return row ?? null
}

// An unaccepted, unexpired admin invite addressed to `email`, optionally one
// that grants `orgId`.
export async function findPendingInvite(executor: Executor, email: string, orgId?: string): Promise<{ id: string } | null> {
  let q = executor
    .selectFrom('invites')
    .select('invites.id')
    .where(sql`lower(invites.email)`, '=', email.toLowerCase())
    .where('invites.kind', '=', 'admin')
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

// Personal apps an invite grants, keyed by invite id. Titles come from the
// registry; an app whose layer is gone shows its id.
export async function getInviteApps(
  executor: Executor,
  inviteIds: string[]
): Promise<Map<string, Array<{ id: string, title: string }>>> {
  const out = new Map<string, Array<{ id: string, title: string }>>()
  if (inviteIds.length === 0) return out
  const rows = await executor
    .selectFrom('invite_apps')
    .select(['invite_id', 'app_id'])
    .where('invite_id', 'in', inviteIds)
    .execute()
  for (const r of rows) {
    const list = out.get(r.invite_id) ?? []
    list.push({ id: r.app_id, title: getRegisteredApp(r.app_id)?.title ?? r.app_id })
    out.set(r.invite_id, list)
  }
  for (const list of out.values()) list.sort((a, b) => a.title.localeCompare(b.title))
  return out
}

export interface AcceptedMembership {
  membershipId: string
  orgId: string
  roles: string[]
  created: boolean
}

// Marks the invite accepted by `userId` and grants its orgs and personal apps,
// or for a share invite, turns its pending shares into shares for `userId`.
// If the user is already in one of those orgs, the invite's roles are added to
// the ones they have. Throws 410 when the invite was accepted concurrently or
// has expired.
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
    .returning('kind')
    .executeTakeFirst()

  if (!claimed) {
    throw createError({ statusCode: 410, statusMessage: 'Invitation has already been used or has expired' })
  }

  // Under RLS the new grantee can't see share rows that don't name them yet,
  // so each table's definer function does the conversion, in this transaction.
  if (claimed.kind === 'share') {
    for (const table of getShareTables().filter(t => t.standard)) {
      await sql`select ${sql.raw(`${table.table}_accept_invite`)}(${inviteId}::uuid, ${userId}::uuid)`.execute(trx)
    }
    return []
  }

  await sql`
    INSERT INTO user_apps (user_id, app_id, granted_by)
    SELECT ${userId}, ia.app_id, i.invited_by
      FROM invite_apps ia
      JOIN invites i ON i.id = ia.invite_id
     WHERE ia.invite_id = ${inviteId}
    ON CONFLICT (user_id, app_id) DO NOTHING
  `.execute(trx)

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

// Fires `invite.accepted` once the accepting transaction has committed, for
// layers that act on an accepted invite (e.g. connecting the inviter and the
// new user in a personal app).
export async function emitInviteAccepted(inviteId: string, userId: string, invitedBy: string | null) {
  try {
    const apps = (await getInviteApps(db, [inviteId])).get(inviteId) ?? []
    await useNitroApp().hooks.callHook('invite.accepted', {
      inviteId,
      userId,
      invitedByUserId: invitedBy,
      appIds: apps.map(a => a.id)
    })
  } catch (err) {
    console.warn('[hook invite.accepted] handler threw:', err)
  }
}

// Fires `invite.accepted` (with no invite id) when an invite to an address
// that already has an account attaches that user directly.
export async function emitInviteAttached(userId: string, invitedBy: string | null, appIds: string[]) {
  try {
    await useNitroApp().hooks.callHook('invite.accepted', { inviteId: null, userId, invitedByUserId: invitedBy, appIds })
  } catch (err) {
    console.warn('[hook invite.accepted] handler threw:', err)
  }
}
