import { randomUUID } from 'node:crypto'
import type { H3Event } from 'h3'
import type { Transaction } from 'kysely'
import { db, sql } from './database'
import { logEvent } from './activity-logger'
import { normalizeEmail } from './email-address'
import { isSelfRegistrationEnabled } from './registration'
import type { Database } from '#core/server/database/schema'
import { launcherPath } from '#core/app/utils/launcher'

// Advisory-lock key used to serialize concurrent account creation so the
// first-user count check and insert can't interleave (ASCII 'reg1').
const REGISTRATION_LOCK_KEY = 1919248689

export interface NewAccount {
  email: string
  display_name: string
  // Already hashed; null for accounts that sign in only through a provider.
  passwordHash: string | null
  verified: boolean
  avatar?: string
  // True when no invite backs this account, so the self-registration setting
  // applies.
  selfSignup: boolean
}

export interface CreatedAccount {
  userId: string
  tokenKey: string
  isFirstUser: boolean
}

// Creates a user row. The very first account on a deployment becomes host
// admin and is marked verified, and is allowed even when self-registration is
// off. Must run inside a transaction; the advisory lock it takes is released
// when that transaction ends.
export async function createUserAccount(
  trx: Transaction<Database>,
  account: NewAccount,
  userAgent?: string
): Promise<CreatedAccount> {
  await sql`SELECT pg_advisory_xact_lock(${sql.lit(REGISTRATION_LOCK_KEY)})`.execute(trx)
  const email = normalizeEmail(account.email)

  const existing = await trx
    .selectFrom('users')
    .select('id')
    .where(sql`lower(email)`, '=', email)
    .executeTakeFirst()
  if (existing) {
    throw createError({ statusCode: 409, statusMessage: 'User with this email already exists' })
  }

  const countRow = await trx
    .selectFrom('users')
    .select(eb => eb.fn.count<string>('id').as('count'))
    .executeTakeFirst()
  const isFirstUser = Number(countRow?.count ?? 0) === 0

  if (account.selfSignup && !isFirstUser && !(await isSelfRegistrationEnabled(trx))) {
    throw createError({ statusCode: 403, statusMessage: 'Registration is closed', data: { code: 'registration_closed' } })
  }

  const userId = randomUUID()
  const tokenKey = randomUUID()
  const now = new Date().toISOString()
  const verified = account.verified || isFirstUser

  // First user is auto-promoted to host admin (single-bit, not a role).
  // Org-level admin assignment happens later when an org is created — host
  // admin is orthogonal to org membership.
  await trx
    .insertInto('users')
    .values({
      id: userId,
      created: now,
      updated: now,
      email,
      password: account.passwordHash,
      verified,
      is_admin: isFirstUser,
      display_name: account.display_name,
      avatar: account.avatar ?? '',
      token_key: tokenKey,
      token_expires_at: verified ? null : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    })
    .execute()

  if (isFirstUser) {
    await logEvent({
      eventType: 'first_user_promoted',
      userId,
      userAgent,
      metadata: { email }
    }, trx)
  }

  return { userId, tokenKey, isFirstUser }
}

// Where to send someone right after they sign in. In multi-tenant mode it
// follows the user's memberships (exactly one → land in that org's launcher;
// none → the org-less launcher, which lists their personal apps; else → the
// org picker). In single-tenant mode there are no orgs, so land on the
// launcher. The orgs/memberships tables only exist when the tenancy layer
// is loaded, so the query is gated on the tenancy flag.
export async function postSignInRedirect(event: H3Event, userId: string): Promise<string> {
  if (useRuntimeConfig(event).public.tenancy !== true) return launcherPath()

  const memberships = await (db as any)
    .selectFrom('memberships')
    .innerJoin('orgs', 'orgs.id', 'memberships.org_id')
    .select(['orgs.slug as slug', 'orgs.suspended_at as suspended_at'])
    .where('memberships.user_id', '=', userId)
    .execute() as Array<{ slug: string, suspended_at: Date | null }>

  if (memberships.length === 0) return launcherPath()
  const active = memberships.filter(m => !m.suspended_at)
  return active.length === 1 ? launcherPath(active[0]!.slug) : '/orgs'
}

// The user fields sign-in responses return to the client.
export async function signInUserPayload(userId: string) {
  const user = await db
    .selectFrom('users')
    .select(['id', 'email', 'display_name', 'avatar', 'verified', 'is_admin'])
    .where('id', '=', userId)
    .executeTakeFirstOrThrow()
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    avatar: user.avatar,
    verified: user.verified,
    is_admin: user.is_admin ?? false,
    permissions: [] as string[]
  }
}
