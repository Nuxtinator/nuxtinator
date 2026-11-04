// Per-user sending identities: alias (routable, so it's an attack surface —
// its management is admin-gated at the route) and signature (a user edits their
// own). Everything rides the caller's org transaction so RLS scopes rows to the
// org; the same alias can legitimately exist in two orgs.
import type { Selectable, Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import { inboxSharedDomain } from './inbox-settings'

type Tx = Transaction<Database>

export type InboxIdentityRow = Selectable<Database['inbox_identities']>

// Reserved local parts that must never be claimed as an alias: `contact` is the
// shared inbox address, `bounce` is Mailgun's VERP return path, and
// `notifications` is a common system sender — routing any of them to a person
// would hijack system mail.
export const INBOX_RESERVED_LOCAL_PARTS = ['contact', 'bounce', 'notifications']

const ALIAS_RE = /^[a-z0-9][a-z0-9._-]*$/i

// Validate + normalize an alias. Returns the lowercased alias, or throws a 400.
// Lowercase because MTAs case-fold the local part; matching is case-insensitive.
export function inboxNormalizeAlias(raw: string): string {
  const alias = raw.trim().toLowerCase()
  if (!ALIAS_RE.test(alias)) {
    throw createError({ statusCode: 400, statusMessage: 'Alias may contain only letters, numbers, dots, hyphens and underscores' })
  }
  if (INBOX_RESERVED_LOCAL_PARTS.includes(alias)) {
    throw createError({ statusCode: 400, statusMessage: `"${alias}" is reserved and cannot be used as an alias` })
  }
  return alias
}

// An alias's personal From address: null without an alias or inbound domain,
// and on the shared slug-address domain, where local parts are org slugs.
export function inboxPersonalFromAddress(alias: string | null, inboundDomain: string): string | null {
  if (!alias || !inboundDomain || inboundDomain === inboxSharedDomain()) return null
  return `${alias}@${inboundDomain}`
}

// Resolve a user's personal From address + signature for an outbound send.
// `personalFrom` is null when inboxPersonalFromAddress gives none — the caller
// then falls back to the shared contact address.
export async function inboxResolvePersonalIdentity(
  tx: Tx,
  userId: string,
  settings: { inboundDomain: string }
): Promise<{ personalFrom: string | null, signature: string | null }> {
  const identity = await inboxGetIdentity(tx, userId)
  const alias = identity?.alias ?? null
  return {
    personalFrom: inboxPersonalFromAddress(alias, settings.inboundDomain),
    signature: identity?.signature ?? null
  }
}

export async function inboxGetIdentity(tx: Tx, userId: string): Promise<InboxIdentityRow | null> {
  const row = await tx
    .selectFrom('inbox_identities')
    .selectAll()
    .where('user_id', '=', userId)
    .executeTakeFirst()
  return row ?? null
}

// Resolve an alias to its owning user, for inbound routing. Aliases are stored
// lowercased and the inbound base arrives lowercased, so an exact match is a
// case-insensitive match.
export async function inboxResolveAliasUser(tx: Tx, alias: string): Promise<string | null> {
  const norm = alias.trim().toLowerCase()
  if (!norm) return null
  const row = await tx
    .selectFrom('inbox_identities')
    .select('user_id')
    .where('alias', '=', norm)
    .executeTakeFirst()
  return row?.user_id ?? null
}

// Upsert a user's identity. `undefined` leaves a field untouched; an explicit
// `null` clears it. Returns { row, changed } where `changed` lists the fields
// that actually moved, so the route can audit only real changes and skip a
// no-op write. Alias is already normalized/validated by the caller.
export async function inboxUpsertIdentity(
  tx: Tx,
  userId: string,
  patch: { alias?: string | null, signature?: string | null }
): Promise<{ row: InboxIdentityRow, changed: string[] }> {
  const existing = await inboxGetIdentity(tx, userId)
  const changed: string[] = []
  if (patch.alias !== undefined && (existing?.alias ?? null) !== (patch.alias ?? null)) changed.push('alias')
  if (patch.signature !== undefined && (existing?.signature ?? null) !== (patch.signature ?? null)) changed.push('signature')

  if (existing) {
    if (!changed.length) return { row: existing, changed }
    const row = await tx
      .updateTable('inbox_identities')
      .set({
        ...(patch.alias !== undefined ? { alias: patch.alias } : {}),
        ...(patch.signature !== undefined ? { signature: patch.signature } : {}),
        updated_at: new Date()
      })
      .where('user_id', '=', userId)
      .returningAll()
      .executeTakeFirstOrThrow()
    return { row, changed }
  }

  const row = await tx
    .insertInto('inbox_identities')
    .values({ user_id: userId, alias: patch.alias ?? null, signature: patch.signature ?? null })
    .returningAll()
    .executeTakeFirstOrThrow()
  return { row, changed: ['alias', 'signature'].filter(f => (row as Record<string, unknown>)[f] != null) }
}
