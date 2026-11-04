// Sharing personal items. A personal app keeps one share table per shareable
// resource (made with `createShareTable` from `@nuxtinator/core/share-tables`
// and registered with `registerShareTable`), and mounts the share routes with
// `defineShareHandler`:
//
//   server/routes/api/<app>/<things>/[id]/shares/index.ts                → GET list, POST share
//   server/routes/api/<app>/<things>/[id]/shares/[shareId].ts            → PATCH role, DELETE
//   server/routes/api/<app>/<things>/[id]/shares/[shareId]/resend.post.ts → POST new link / email
//
//   export default defineShareHandler({ appId: 'notes', table: 'notes_note_shares', permission: 'notes.read' })
//
// The `<ShareDialog :endpoint>` component talks to those routes.
//
// Everything runs in the caller's personal-app transaction, so the share
// table's policies decide what the caller sees and changes: the resource's
// owner manages its shares, a grantee sees the other accepted shares and can
// remove their own. A person is shared with directly only once they're a
// known person (someone who accepted a share from the caller, or whose share
// the caller accepted); anyone else gets an email invite or a single-use
// link, and nothing reaches their account until they accept it.

import type { H3Event, EventHandler, EventHandlerRequest } from 'h3'
import { getRouterParam } from 'h3'
import { sql, type Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { Permission } from '#core/app/utils/permissions'
import { sendTemplateEmail } from '#email'
import { afterCommit, txScopeFor } from './after-commit'
import { requireAuth } from './auth'
import { getRegisteredApp } from './app-registry'
import { createInvite, inviteState, renewInvite } from './invites'
import { withUserPermission } from './personal-apps'
import { consumeRateLimit } from './rate-limit'
import { getShareTable, getShareTables } from './share-registry'

type Tx = Transaction<Database>

export type ShareRole = 'viewer' | 'editor'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Share-invite emails a user may send per hour.
export const SHARE_EMAILS_PER_HOUR = 20
const HOUR_MS = 60 * 60 * 1000

export interface KnownPerson {
  id: string
  display_name: string
  avatar: string | null
}

// The people `userId` has shared with or been shared with, in any app, once
// accepted. Run inside a transaction with `app.current_user` set to `userId`:
// each share table's policies limit it to the caller's own shares.
export async function getKnownPeople(tx: Tx, userId: string): Promise<KnownPerson[]> {
  const tables = getShareTables()
  if (tables.length === 0) return []
  const parts = tables.map(t => sql`
    select ${sql.ref(t.granteeColumn)} as person from ${sql.table(t.table)}
     where ${sql.ref(t.grantorColumn)} = ${userId} and ${sql.ref(t.granteeColumn)} is not null
    union all
    select ${sql.ref(t.grantorColumn)} from ${sql.table(t.table)}
     where ${sql.ref(t.granteeColumn)} = ${userId} and ${sql.ref(t.grantorColumn)} is not null
  `)
  const { rows } = await sql<KnownPerson>`
    select u.id, u.display_name, u.avatar
      from users u
     where u.id in (select person from (${sql.join(parts, sql` union all `)}) k)
       and u.id <> ${userId}
     order by lower(u.display_name)
  `.execute(tx)
  return rows
}

// Runs `fn` in a transaction as `userId`, outside any one app.
export async function runAsShareUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return await txScopeFor(null, userId)(fn)
}

export interface ShareListEntry {
  id: string
  role: ShareRole
  user: KnownPerson | null
  // Set while the share waits for its invite to be accepted.
  pending: { email: string | null, expired: boolean } | null
  created_at: Date
}

interface ShareRow {
  id: string
  role: ShareRole
  grantee_user_id: string | null
  grantee_invite_id: string | null
  created_at: Date
}

function requireStandardTable(table: string) {
  const entry = getShareTable(table)
  if (!entry?.standard) throw new Error(`[shares] "${table}" is not a registered share table made by createShareTable`)
  return entry
}

async function resourceOwner(tx: Tx, table: string, resourceId: string): Promise<string | null> {
  const { rows } = await sql<{ owner: string | null }>`select ${sql.raw(`${table}_resource_owner`)}(${resourceId}::uuid) as owner`.execute(tx)
  return rows[0]?.owner ?? null
}

async function ownShare(tx: Tx, table: string, resourceId: string, userId: string): Promise<ShareRow | null> {
  const { rows } = await sql<ShareRow>`
    select id, role, grantee_user_id, grantee_invite_id, created_at from ${sql.table(table)}
     where resource_id = ${resourceId} and grantee_user_id = ${userId}
  `.execute(tx)
  return rows[0] ?? null
}

async function getShare(tx: Tx, table: string, resourceId: string, shareId: string): Promise<ShareRow | null> {
  const { rows } = await sql<ShareRow>`
    select id, role, grantee_user_id, grantee_invite_id, created_at from ${sql.table(table)}
     where id = ${shareId} and resource_id = ${resourceId}
  `.execute(tx)
  return rows[0] ?? null
}

export async function listResourceShares(tx: Tx, table: string, resourceId: string): Promise<ShareListEntry[]> {
  requireStandardTable(table)
  const { rows } = await sql<ShareRow & { display_name: string | null, avatar: string | null, email: string | null, expires_at: Date | null, accepted_at: Date | null }>`
    select s.id, s.role, s.grantee_user_id, s.grantee_invite_id, s.created_at,
           u.display_name, u.avatar, i.email, i.expires_at, i.accepted_at
      from ${sql.table(table)} s
      left join users u on u.id = s.grantee_user_id
      left join invites i on i.id = s.grantee_invite_id
     where s.resource_id = ${resourceId}
     order by s.grantee_user_id is null, s.created_at
  `.execute(tx)
  return rows.map(r => ({
    id: r.id,
    role: r.role,
    user: r.grantee_user_id ? { id: r.grantee_user_id, display_name: r.display_name ?? '', avatar: r.avatar } : null,
    pending: r.grantee_invite_id
      ? { email: r.email, expired: inviteState({ accepted_at: r.accepted_at, expires_at: r.expires_at! }) !== 'valid' }
      : null,
    created_at: r.created_at
  }))
}

// Shares with a known person, or changes the role of their existing share.
export async function shareWithUser(
  tx: Tx,
  input: { table: string, resourceId: string, userId: string, role: ShareRole, grantedBy: string }
): Promise<{ id: string }> {
  requireStandardTable(input.table)
  const known = await getKnownPeople(tx, input.grantedBy)
  if (!known.some(p => p.id === input.userId)) {
    throw createError({ statusCode: 400, statusMessage: 'Share with this person by email or link first' })
  }
  const { rows } = await sql<{ id: string }>`
    insert into ${sql.table(input.table)} (resource_id, grantee_user_id, role, granted_by)
    values (${input.resourceId}, ${input.userId}, ${input.role}, ${input.grantedBy})
    on conflict (resource_id, grantee_user_id) where grantee_user_id is not null
    do update set role = excluded.role
    returning id
  `.execute(tx)
  return rows[0]!
}

// Creates a single-use share invite and its pending share. With `email`, the
// invite is emailed after commit; without, the caller hands out the link.
export async function shareByInvite(
  tx: Tx,
  input: {
    table: string
    resourceId: string
    email: string | null
    role: ShareRole
    grantedBy: string
    // For the email: the sharer's name, the item's label and the app's title.
    inviterName?: string | null
    itemLabel?: string | null
    appTitle?: string | null
  }
): Promise<{ id: string, url: string }> {
  requireStandardTable(input.table)
  const email = input.email?.trim().toLowerCase() || null
  if (email !== null && !EMAIL_RE.test(email)) {
    throw createError({ statusCode: 400, statusMessage: 'A valid email is required' })
  }
  if (email !== null) {
    const limit = await consumeRateLimit('SHARE_INVITE_EMAIL', 'userId', input.grantedBy, HOUR_MS, SHARE_EMAILS_PER_HOUR)
    if (!limit.allowed) {
      throw createError({ statusCode: 429, statusMessage: 'Too many share emails. Try again later or share a link.' })
    }
  }

  const invite = await createInvite(tx, { email, display_name: null, invitedBy: input.grantedBy, orgs: [], kind: 'share' })
  const { rows } = await sql<{ id: string }>`
    insert into ${sql.table(input.table)} (resource_id, grantee_invite_id, role, granted_by)
    values (${input.resourceId}, ${invite.id}, ${input.role}, ${input.grantedBy})
    returning id
  `.execute(tx)

  if (email !== null) {
    await afterCommit(tx, async () => {
      try {
        await sendTemplateEmail({
          to: email,
          template: 'shareInvite',
          data: { inviterName: input.inviterName, itemLabel: input.itemLabel, sharedIn: input.appTitle, inviteUrl: invite.url }
        })
      } catch (err) {
        console.error('[shares] share invite email failed:', err)
      }
    })
  }
  return { id: rows[0]!.id, url: invite.url }
}

export async function setResourceShareRole(tx: Tx, input: { table: string, resourceId: string, shareId: string, role: ShareRole }): Promise<void> {
  requireStandardTable(input.table)
  await sql`update ${sql.table(input.table)} set role = ${input.role} where id = ${input.shareId} and resource_id = ${input.resourceId}`.execute(tx)
}

// Removes a share. A pending share's invite goes with it, so its link stops
// working.
export async function removeResourceShare(tx: Tx, input: { table: string, resourceId: string, shareId: string }): Promise<void> {
  requireStandardTable(input.table)
  const share = await getShare(tx, input.table, input.resourceId, input.shareId)
  if (!share) return
  await sql`delete from ${sql.table(input.table)} where id = ${share.id}`.execute(tx)
  if (share.grantee_invite_id) {
    await tx.deleteFrom('invites')
      .where('id', '=', share.grantee_invite_id)
      .where('kind', '=', 'share')
      .where('accepted_at', 'is', null)
      .execute()
  }
}

export interface ShareHandlerOptions {
  appId: string
  // A registered share table made by `createShareTable`.
  table: string
  // Needed to see or manage the shares (usually the app's read permission).
  permission: Permission
  // The router param holding the resource id (default 'id').
  param?: string
  // The item's label, for share emails.
  label?: (tx: Tx, resourceId: string) => Promise<string | null>
}

function parseRole(value: unknown): ShareRole {
  if (value !== 'viewer' && value !== 'editor') {
    throw createError({ statusCode: 400, statusMessage: 'role must be viewer | editor' })
  }
  return value
}

// The share routes for one resource; see the top of this file for the files
// to mount it in.
export function defineShareHandler(opts: ShareHandlerOptions): EventHandler<EventHandlerRequest, Promise<unknown>> {
  return defineEventHandler(async (event: H3Event) => {
    const resourceId = getRouterParam(event, opts.param ?? 'id') ?? ''
    if (!UUID_RE.test(resourceId)) throw createError({ statusCode: 404, statusMessage: 'Not found' })
    const shareId = getRouterParam(event, 'shareId')
    if (shareId !== undefined && !UUID_RE.test(shareId)) throw createError({ statusCode: 404, statusMessage: 'Share not found' })
    const resend = shareId !== undefined && (event.path ?? '').split('?')[0]!.endsWith('/resend')
    const method = event.method
    const body = method === 'POST' || method === 'PATCH' ? await readBody(event).catch(() => null) : null
    const { userId } = requireAuth(event)

    return await withUserPermission(event, { appId: opts.appId }, opts.permission, async (tx) => {
      requireStandardTable(opts.table)
      const owner = await resourceOwner(tx, opts.table, resourceId)
      const isOwner = owner !== null && owner === userId
      const mine = isOwner ? null : await ownShare(tx, opts.table, resourceId, userId)
      if (!isOwner && !mine) throw createError({ statusCode: 404, statusMessage: 'Not found' })
      const requireOwner = () => {
        if (!isOwner) throw createError({ statusCode: 403, statusMessage: 'Only the owner can change who this is shared with' })
      }

      if (shareId === undefined) {
        if (method === 'GET') {
          const ownerRow = owner
            ? await tx.selectFrom('users').select(['id', 'display_name', 'avatar']).where('id', '=', owner).executeTakeFirst()
            : undefined
          return {
            canManage: isOwner,
            owner: ownerRow ?? null,
            shares: await listResourceShares(tx, opts.table, resourceId)
          }
        }
        if (method === 'POST') {
          requireOwner()
          const role = parseRole(body?.role)
          if (typeof body?.userId === 'string') {
            return await shareWithUser(tx, { table: opts.table, resourceId, userId: body.userId, role, grantedBy: userId })
          }
          if (typeof body?.email === 'string' || body?.link === true) {
            const me = await tx.selectFrom('users').select('display_name').where('id', '=', userId).executeTakeFirst()
            return await shareByInvite(tx, {
              table: opts.table,
              resourceId,
              email: typeof body?.email === 'string' ? body.email : null,
              role,
              grantedBy: userId,
              inviterName: me?.display_name,
              itemLabel: opts.label ? await opts.label(tx, resourceId) : null,
              appTitle: getRegisteredApp(opts.appId)?.title
            })
          }
          throw createError({ statusCode: 400, statusMessage: 'Give a userId, an email, or link: true' })
        }
        throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
      }

      const share = await getShare(tx, opts.table, resourceId, shareId)
      if (!share) throw createError({ statusCode: 404, statusMessage: 'Share not found' })

      if (resend) {
        if (method !== 'POST') throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
        requireOwner()
        if (!share.grantee_invite_id) throw createError({ statusCode: 400, statusMessage: 'This share has been accepted' })
        const invite = await tx.selectFrom('invites').select(['email']).where('id', '=', share.grantee_invite_id).executeTakeFirstOrThrow()
        const renewed = await renewInvite(tx, share.grantee_invite_id)
        if (invite.email) {
          const limit = await consumeRateLimit('SHARE_INVITE_EMAIL', 'userId', userId, HOUR_MS, SHARE_EMAILS_PER_HOUR)
          if (!limit.allowed) throw createError({ statusCode: 429, statusMessage: 'Too many share emails. Try again later or share a link.' })
          const me = await tx.selectFrom('users').select('display_name').where('id', '=', userId).executeTakeFirst()
          const itemLabel = opts.label ? await opts.label(tx, resourceId) : null
          const email = invite.email
          await afterCommit(tx, async () => {
            try {
              await sendTemplateEmail({
                to: email,
                template: 'shareInvite',
                data: { inviterName: me?.display_name, itemLabel, sharedIn: getRegisteredApp(opts.appId)?.title, inviteUrl: renewed.url }
              })
            } catch (err) {
              console.error('[shares] share invite email failed:', err)
            }
          })
        }
        return { id: share.id, url: renewed.url }
      }

      if (method === 'PATCH') {
        requireOwner()
        await setResourceShareRole(tx, { table: opts.table, resourceId, shareId, role: parseRole(body?.role) })
        return { id: shareId }
      }
      if (method === 'DELETE') {
        if (!isOwner && share.grantee_user_id !== userId) requireOwner()
        await removeResourceShare(tx, { table: opts.table, resourceId, shareId })
        return { id: shareId }
      }
      throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
    })
  })
}
