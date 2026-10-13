import { db, sql } from '#core/server/utils/database'
import { createUserAccount } from '#core/server/utils/accounts'
import { acceptInvite, emitAcceptedMemberships, findInviteByToken, inviteState } from '#core/server/utils/invites'
import { encryptSecret } from '#core/server/utils/secret-crypto'
import { isPublicStorageConfigured, uploadToS3 } from '#core/server/utils/storage'
import { logEvent } from '#core/server/utils/activity-logger'
import type { SocialProfile, SocialProviderId } from './social-providers'
import type { SocialIntent } from './social-flow'

// What happens when a provider vouches for someone. Shared by the web
// callback, the native token endpoint and the display-name step.

export type SignInErrorCode = 'email_unverified' | 'unverified_account' | 'already_linked' | 'one_per_provider' | 'failed'

export type SignInOutcome
  = { kind: 'signed_in', userId: string, created: boolean, inviteAccepted: boolean }
    | { kind: 'needs_name' }
    | { kind: 'linked', userId: string }
    | { kind: 'reauthed', userId: string }
    | { kind: 'error', code: SignInErrorCode }

export interface SignInInput {
  provider: SocialProviderId
  profile: SocialProfile
  intent: SocialIntent
  // The signed-in user, for link and reauth.
  userId: string | null
  invite: string | null
  // Overrides the provider's name (the display-name step, or a native app
  // passing the name Apple gave it on first sign-in).
  displayName?: string | null
  clientId: string | null
  refreshTokenEnc: string | null
  userAgent?: string
}

export function encryptRefreshToken(token: string | null): string | null {
  if (!token) return null
  try {
    return encryptSecret(token)
  } catch (err) {
    console.warn('[social-auth] not storing provider refresh token (NUXT_SECRET_ENCRYPTION_KEY unusable):', (err as Error).message)
    return null
  }
}

async function findIdentity(provider: string, subject: string) {
  return await db
    .selectFrom('user_identities')
    .select(['id', 'user_id'])
    .where('provider', '=', provider)
    .where('subject', '=', subject)
    .executeTakeFirst()
}

async function touchIdentity(id: string, input: SignInInput) {
  await db
    .updateTable('user_identities')
    .set({
      email: input.profile.email,
      last_used_at: new Date(),
      ...(input.refreshTokenEnc ? { refresh_token_enc: input.refreshTokenEnc, client_id: input.clientId } : {})
    })
    .where('id', '=', id)
    .execute()
}

function identityRow(userId: string, input: SignInInput) {
  return {
    user_id: userId,
    provider: input.provider,
    subject: input.profile.subject,
    email: input.profile.email,
    client_id: input.refreshTokenEnc ? input.clientId : null,
    refresh_token_enc: input.refreshTokenEnc
  }
}

async function hasIdentityFor(userId: string, provider: string): Promise<boolean> {
  const row = await db
    .selectFrom('user_identities')
    .select('id')
    .where('user_id', '=', userId)
    .where('provider', '=', provider)
    .executeTakeFirst()
  return !!row
}

function logLinked(userId: string, input: SignInInput) {
  logEvent({
    eventType: 'AUTH_PROVIDER_LINKED',
    tableName: 'users',
    recordId: userId,
    userId,
    userAgent: input.userAgent,
    metadata: { provider: input.provider }
  })
}

export async function completeSocialSignIn(input: SignInInput): Promise<SignInOutcome> {
  const { profile } = input
  const identity = await findIdentity(input.provider, profile.subject)

  if (input.intent === 'reauth') {
    if (!identity || identity.user_id !== input.userId) return { kind: 'error', code: 'failed' }
    await touchIdentity(identity.id, input)
    return { kind: 'reauthed', userId: identity.user_id }
  }

  if (input.intent === 'link') {
    if (!input.userId) return { kind: 'error', code: 'failed' }
    if (identity) {
      return identity.user_id === input.userId
        ? { kind: 'linked', userId: input.userId }
        : { kind: 'error', code: 'already_linked' }
    }
    if (await hasIdentityFor(input.userId, input.provider)) return { kind: 'error', code: 'one_per_provider' }
    await db.insertInto('user_identities').values(identityRow(input.userId, input)).execute()
    logLinked(input.userId, input)
    await importAvatar(input.userId, profile.picture)
    return { kind: 'linked', userId: input.userId }
  }

  if (identity) {
    await touchIdentity(identity.id, input)
    return { kind: 'signed_in', userId: identity.user_id, created: false, inviteAccepted: false }
  }

  if (!profile.email) return { kind: 'error', code: 'failed' }
  if (!profile.emailVerified) return { kind: 'error', code: 'email_unverified' }

  // An existing account with this email is linked automatically — but only if
  // that account proved it owns the address. Otherwise whoever registered it
  // first (possibly not the owner) would inherit the owner's provider sign-in.
  const existing = await db
    .selectFrom('users')
    .select(['id', 'verified'])
    .where(sql`lower(email)`, '=', profile.email)
    .executeTakeFirst()
  if (existing) {
    if (!existing.verified) return { kind: 'error', code: 'unverified_account' }
    if (await hasIdentityFor(existing.id, input.provider)) return { kind: 'error', code: 'one_per_provider' }
    await db.insertInto('user_identities').values(identityRow(existing.id, input)).execute()
    logLinked(existing.id, input)
    await importAvatar(existing.id, profile.picture)
    return { kind: 'signed_in', userId: existing.id, created: false, inviteAccepted: false }
  }

  const displayName = (input.displayName ?? profile.name ?? '').trim()
  if (displayName.length < 2) return { kind: 'needs_name' }

  const invite = input.invite ? await findInviteByToken(db, input.invite) : null
  const usableInvite = invite && inviteState(invite) === 'valid' ? invite : null

  const { account, memberships } = await db.transaction().execute(async (trx) => {
    const account = await createUserAccount(trx, {
      email: profile.email!,
      display_name: displayName,
      passwordHash: null,
      verified: true
    }, input.userAgent)
    await trx.insertInto('user_identities').values(identityRow(account.userId, input)).execute()
    const memberships = usableInvite ? await acceptInvite(trx, usableInvite.id, account.userId) : []
    return { account, memberships }
  })

  try {
    await useNitroApp().hooks.callHook('user.created', { userId: account.userId, email: profile.email, viaInvite: !!usableInvite })
  } catch (err) {
    console.warn('[hook user.created] handler threw:', err)
  }
  if (usableInvite) {
    await emitAcceptedMemberships(memberships, account.userId, usableInvite.invited_by)
    logEvent({
      eventType: 'invite_accepted',
      tableName: 'invites',
      recordId: usableInvite.id,
      userId: account.userId,
      userAgent: input.userAgent,
      metadata: { invited_email: usableInvite.email, email: profile.email, existing_account: false, provider: input.provider }
    })
  }
  logEvent({
    eventType: 'REGISTER_SOCIAL',
    tableName: 'users',
    recordId: account.userId,
    userId: account.userId,
    userAgent: input.userAgent,
    metadata: { provider: input.provider }
  })
  await importAvatar(account.userId, profile.picture)

  return { kind: 'signed_in', userId: account.userId, created: true, inviteAccepted: !!usableInvite }
}

const AVATAR_MAX_BYTES = 2 * 1024 * 1024

// Sets the user's avatar from the provider's photo, unless they already have
// one. The image is copied to the app's public storage when S3 is configured;
// otherwise the provider's URL is stored as-is.
async function importAvatar(userId: string, pictureUrl: string | null): Promise<void> {
  if (!pictureUrl || !/^https:\/\//.test(pictureUrl)) return
  try {
    const user = await db.selectFrom('users').select('avatar').where('id', '=', userId).executeTakeFirst()
    if (!user || user.avatar) return

    let avatar = pictureUrl
    if (isPublicStorageConfigured()) {
      try {
        const res = await fetch(pictureUrl)
        const contentType = res.headers.get('content-type') || ''
        if (res.ok && contentType.startsWith('image/')) {
          const buf = Buffer.from(await res.arrayBuffer())
          if (buf.length <= AVATAR_MAX_BYTES) {
            const ext = contentType.split('/')[1]?.split(';')[0] || 'jpg'
            const uploaded = await uploadToS3(buf, `avatar.${ext}`, contentType, 'public', 'avatars')
            avatar = uploaded.url
          }
        }
      } catch {
        // The copy failed: keep the provider's URL.
      }
    }

    await db.updateTable('users').set({ avatar }).where('id', '=', userId).where('avatar', '=', '').execute()
  } catch (err) {
    console.warn('[social-auth] avatar import failed:', (err as Error).message)
  }
}
