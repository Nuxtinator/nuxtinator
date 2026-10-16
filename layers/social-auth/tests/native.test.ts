import { describe, it, expect, afterEach, inject } from 'vitest'
import { randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import {
  getHostAdminDb,
  createTestUser,
  createPendingInvite,
  cleanupSocialTestData,
  api,
  googleIdToken,
  appleIdToken,
  socialEmail,
  photoUrl,
  publicStorageConfigured,
  waitForAvatar,
  TEST_GOOGLE_WEB_CLIENT
} from './helpers'

const NATIVE = { 'x-auth-client': 'native' }
// With public storage configured, provider photos are copied into it;
// otherwise the provider's URL is stored as-is.
const STORAGE = publicStorageConfigured()
const STORED = /\/avatars\/[0-9a-f]+\.png$/
const UNLISTED_HOST_RESOLVES = await lookup('localhost.').then(() => true, () => false)

interface NativeResult {
  accessToken: string
  refreshToken: string
  created: boolean
  inviteNeedsConfirmation: boolean
}

async function nativeSignIn(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return await api<NativeResult>('/api/social-auth/native', {
    method: 'POST',
    headers: { ...NATIVE, ...headers },
    body
  })
}

describe('POST /api/social-auth/native', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupSocialTestData(sql)
  })

  it('lists the configured web provider for the auth pages', async () => {
    const providers = await api<Array<{ id: string }>>('/api/_auth-providers')
    expect(providers.map(p => p.id)).toContain('google')
  })

  it('creates a verified, password-less account on first sign-in and signs in to it after', async () => {
    const email = socialEmail()
    const sub = randomUUID()
    const first = await nativeSignIn({ provider: 'google', idToken: googleIdToken({ sub, email, name: 'Goo Gler' }) })
    expect(first.created).toBe(true)
    expect(first.accessToken).toBeTruthy()

    const users = await sql<{ id: string, verified: boolean, password: string | null, display_name: string }[]>`
      SELECT id, verified, password, display_name FROM users WHERE email = ${email}`
    expect(users[0]!.verified).toBe(true)
    expect(users[0]!.password).toBeNull()
    expect(users[0]!.display_name).toBe('Goo Gler')

    const second = await nativeSignIn({ provider: 'google', idToken: googleIdToken({ sub, email }) })
    expect(second.created).toBe(false)
    const me = await api('/api/auth/me', { headers: { authorization: `Bearer ${second.accessToken}` } })
    expect(me.user.id).toBe(users[0]!.id)
  })

  describe('provider photo', () => {
    async function signUpWithPhoto(path: string) {
      const email = socialEmail()
      const sub = randomUUID()
      const res = await nativeSignIn({ provider: 'google', idToken: googleIdToken({ sub, email, name: 'Photo Owner', picture: photoUrl(path) }) })
      const bearer = { headers: { authorization: `Bearer ${res.accessToken}` } }
      return { email, sub, bearer }
    }

    it('is copied to storage, or stored as-is without storage', async () => {
      const { email, bearer } = await signUpWithPhoto('/photo.png')
      const avatar = await waitForAvatar(sql, email, a => a !== '')
      if (STORAGE) expect(avatar).toMatch(STORED)
      else expect(avatar).toBe(photoUrl('/photo.png'))
      await api('/api/profile/avatar', { method: 'DELETE', ...bearer })
    })

    it.skipIf(!STORAGE)('follows an HTTPS redirect', async () => {
      const { email, bearer } = await signUpWithPhoto('/redirect')
      expect(await waitForAvatar(sql, email, a => a !== '')).toMatch(STORED)
      await api('/api/profile/avatar', { method: 'DELETE', ...bearer })
    })

    // `localhost.` reaches the photo host and passes its certificate but isn't a listed host.
    it.skipIf(!UNLISTED_HOST_RESOLVES)('is skipped when it comes from a host not listed for the provider', async () => {
      const email = socialEmail()
      const picture = photoUrl('/photo.png').replace('//localhost:', '//localhost.:')
      await nativeSignIn({ provider: 'google', idToken: googleIdToken({ sub: randomUUID(), email, name: 'Elsewhere', picture }) })
      expect(await waitForAvatar(sql, email, a => a !== '', 1500)).toBe('')
    })

    it.skipIf(!STORAGE)('is skipped when a redirect leads to plain HTTP or an IP address', async () => {
      const toHttp = await signUpWithPhoto('/to-http')
      const toIp = await signUpWithPhoto('/to-ip')
      expect(await waitForAvatar(sql, toHttp.email, a => a !== '', 1500)).toBe('')
      expect(await waitForAvatar(sql, toIp.email, a => a !== '', 1500)).toBe('')
    })

    it('is not imported again on a later sign-in through the linked provider', async () => {
      const { email, sub, bearer } = await signUpWithPhoto('/photo.png')
      await waitForAvatar(sql, email, a => a !== '')
      await api('/api/profile/avatar', { method: 'DELETE', ...bearer })

      await nativeSignIn({ provider: 'google', idToken: googleIdToken({ sub, email, picture: photoUrl('/photo.png') }) })
      expect(await waitForAvatar(sql, email, a => a !== '', 1500)).toBe('')
    })
  })

  it('accepts the web client id as audience (Android)', async () => {
    const res = await nativeSignIn({
      provider: 'google',
      idToken: googleIdToken({ sub: randomUUID(), email: socialEmail(), name: 'Droid User' }, { aud: TEST_GOOGLE_WEB_CLIENT })
    })
    expect(res.accessToken).toBeTruthy()
  })

  it('links to an existing verified account with the same email', async () => {
    const user = await createTestUser(sql, { email: socialEmail() })
    const res = await nativeSignIn({ provider: 'google', idToken: googleIdToken({ sub: randomUUID(), email: user.email, name: 'Same Person' }) })
    expect(res.created).toBe(false)
    const ids = await sql`SELECT 1 FROM user_identities WHERE user_id = ${user.id} AND provider = 'google'`
    expect(ids.length).toBe(1)
  })

  it('refuses to link to an account that never verified its email', async () => {
    const user = await createTestUser(sql, { email: socialEmail(), verified: false })
    const err = await nativeSignIn({ provider: 'google', idToken: googleIdToken({ sub: randomUUID(), email: user.email, name: 'Squatter Victim' }) }).catch(e => e)
    expect(err.statusCode).toBe(409)
    expect(err.data?.data?.code).toBe('unverified_account')
  })

  it('refuses an email the provider has not verified', async () => {
    const err = await nativeSignIn({ provider: 'google', idToken: googleIdToken({ sub: randomUUID(), email: socialEmail(), email_verified: false, name: 'Nope' }) }).catch(e => e)
    expect(err.statusCode).toBe(409)
    expect(err.data?.data?.code).toBe('email_unverified')
  })

  it('asks for a name when the provider sends none (Apple), then creates the account', async () => {
    const email = socialEmail()
    const sub = randomUUID()
    const err = await nativeSignIn({ provider: 'apple', idToken: appleIdToken({ sub, email }) }).catch(e => e)
    expect(err.statusCode).toBe(422)
    expect(err.data?.data?.needsDisplayName).toBe(true)

    const res = await nativeSignIn({ provider: 'apple', idToken: appleIdToken({ sub, email }), displayName: 'Apple Person' })
    expect(res.created).toBe(true)
    const users = await sql<{ display_name: string }[]>`SELECT display_name FROM users WHERE email = ${email}`
    expect(users[0]!.display_name).toBe('Apple Person')
  })

  it('rejects a token for another audience, a bad issuer, or a wrong nonce', async () => {
    const email = socialEmail()
    const wrongAud = await nativeSignIn({ provider: 'google', idToken: googleIdToken({ sub: randomUUID(), email, name: 'X Y' }, { aud: 'someone-else' }) }).catch(e => e)
    expect(wrongAud.statusCode).toBe(401)

    const wrongIss = await nativeSignIn({ provider: 'google', idToken: googleIdToken({ sub: randomUUID(), email, name: 'X Y' }, { iss: 'https://evil.example' }) }).catch(e => e)
    expect(wrongIss.statusCode).toBe(401)

    const wrongNonce = await nativeSignIn({ provider: 'google', idToken: googleIdToken({ sub: randomUUID(), email, name: 'X Y', nonce: 'abc' }), nonce: 'xyz' }).catch(e => e)
    expect(wrongNonce.statusCode).toBe(401)

    const ok = await nativeSignIn({ provider: 'google', idToken: googleIdToken({ sub: randomUUID(), email, name: 'X Y', nonce: 'abc' }), nonce: 'abc' })
    expect(ok.accessToken).toBeTruthy()
  })

  it('a new account accepts the invite it signed up through', async () => {
    const invite = await createPendingInvite(sql, { email: null, display_name: 'test-social-link' })
    const email = socialEmail()
    const res = await nativeSignIn({ provider: 'google', idToken: googleIdToken({ sub: randomUUID(), email, name: 'Invited Person' }), invite: invite.token })
    expect(res.inviteNeedsConfirmation).toBe(false)
    const rows = await sql<{ accepted_by: string | null }[]>`SELECT accepted_by FROM invites WHERE id = ${invite.inviteId}`
    expect(rows[0]!.accepted_by).toBeTruthy()
  })

  it('an existing account is asked to confirm the invite', async () => {
    const user = await createTestUser(sql, { email: socialEmail() })
    const invite = await createPendingInvite(sql, { email: null, display_name: 'test-social-link' })
    const res = await nativeSignIn({ provider: 'google', idToken: googleIdToken({ sub: randomUUID(), email: user.email }), invite: invite.token })
    expect(res.inviteNeedsConfirmation).toBe(true)
  })

  it('creates accounts only through an invite while self-registration is off', async () => {
    const existing = await createTestUser(sql, { email: socialEmail() })
    const invite = await createPendingInvite(sql, { email: null, display_name: 'test-social-link' })
    const expiredInvite = await createPendingInvite(sql, { email: null, display_name: 'test-social-link', expiresInMs: -1000 })
    await sql`
      INSERT INTO core_host_settings (namespace, key, value) VALUES ('core', 'self_registration', 'false'::jsonb)
      ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value`
    try {
      const err = await nativeSignIn({ provider: 'google', idToken: googleIdToken({ sub: randomUUID(), email: socialEmail(), name: 'Uninvited' }) }).catch(e => e)
      expect(err.statusCode).toBe(403)
      expect(err.data?.data?.code).toBe('registration_closed')

      const expired = await nativeSignIn({ provider: 'google', idToken: googleIdToken({ sub: randomUUID(), email: socialEmail(), name: 'Late' }), invite: expiredInvite.token }).catch(e => e)
      expect(expired.statusCode).toBe(410)
      expect(expired.data?.data?.code).toBe('invite_invalid')

      const signedIn = await nativeSignIn({ provider: 'google', idToken: googleIdToken({ sub: randomUUID(), email: existing.email }) })
      expect(signedIn.created).toBe(false)

      const invited = await nativeSignIn({ provider: 'google', idToken: googleIdToken({ sub: randomUUID(), email: socialEmail(), name: 'Invited' }), invite: invite.token })
      expect(invited.created).toBe(true)
    } finally {
      await sql`DELETE FROM core_host_settings WHERE namespace = 'core' AND key = 'self_registration'`
    }
  })

  it('links a second provider to the signed-in account, and refuses one owned by someone else', async () => {
    const email = socialEmail()
    const first = await nativeSignIn({ provider: 'google', idToken: googleIdToken({ sub: randomUUID(), email, name: 'Linker' }) })
    const bearer = { authorization: `Bearer ${first.accessToken}` }

    const appleSub = randomUUID()
    await nativeSignIn({ provider: 'apple', intent: 'link', idToken: appleIdToken({ sub: appleSub, email: 'relay@privaterelay.appleid.com' }) }, bearer)
    const methods = await api<{ count: number }>('/api/auth/methods', { headers: bearer })
    // Apple has no web credentials in tests, so only Google is a registered method.
    expect(methods.count).toBe(1)
    const ids = await sql`SELECT provider FROM user_identities WHERE subject = ${appleSub}`
    expect(ids.length).toBe(1)

    const other = await nativeSignIn({ provider: 'google', idToken: googleIdToken({ sub: randomUUID(), email: socialEmail(), name: 'Other' }) })
    const err = await nativeSignIn({ provider: 'apple', intent: 'link', idToken: appleIdToken({ sub: appleSub, email: 'relay@privaterelay.appleid.com' }) }, { authorization: `Bearer ${other.accessToken}` }).catch(e => e)
    expect(err.statusCode).toBe(409)
    expect(err.data?.data?.code).toBe('already_linked')
  })

  it('refuses to link a provider without a recent re-authentication', async () => {
    const email = socialEmail()
    const first = await nativeSignIn({ provider: 'google', idToken: googleIdToken({ sub: randomUUID(), email, name: 'Stale' }) })
    const bearer = { authorization: `Bearer ${first.accessToken}` }
    await sql`
      UPDATE sessions SET authenticated_at = now() - interval '1 day'
      WHERE user_id = (SELECT id FROM users WHERE email = ${email})
    `

    const appleSub = randomUUID()
    const err = await nativeSignIn({ provider: 'apple', intent: 'link', idToken: appleIdToken({ sub: appleSub, email: 'relay@privaterelay.appleid.com' }) }, bearer).catch(e => e)
    expect(err.statusCode).toBe(403)
    expect(err.data?.data?.reauth).toBe(true)
    expect(await sql`SELECT 1 FROM user_identities WHERE subject = ${appleSub}`).toHaveLength(0)

    const recent = await api('/api/auth/recent', { headers: bearer }).catch(e => e)
    expect(recent.statusCode).toBe(403)

    const start = await fetch(new URL('/api/social-auth/google/start?intent=link&redirect=/account', inject('socialAuthUrl')), { headers: bearer, redirect: 'manual' })
    expect(start.headers.get('location')).toContain('link=reauth_required')
  })

  it('won\'t unlink the only way to sign in, but will once a password is set', async () => {
    const email = socialEmail()
    const res = await nativeSignIn({ provider: 'google', idToken: googleIdToken({ sub: randomUUID(), email, name: 'Only Google' }) })
    const bearer = { authorization: `Bearer ${res.accessToken}` }

    const blocked = await api('/api/auth/methods/google', { method: 'DELETE', headers: bearer }).catch(e => e)
    expect(blocked.statusCode).toBe(409)

    await api('/api/profile/password', { method: 'PATCH', headers: bearer, body: { new_password: 'nowihaveapw' } })
    await api('/api/auth/methods/google', { method: 'DELETE', headers: bearer })
    const ids = await sql`SELECT 1 FROM user_identities i JOIN users u ON u.id = i.user_id WHERE u.email = ${email}`
    expect(ids.length).toBe(0)
  })
})
