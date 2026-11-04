// Social-auth test helpers. ID tokens are signed with a throwaway RSA key
// whose public half global-setup serves as the providers' JWKS, so the real
// verification path runs end to end. Seeded users are prefixed
// `test-social-` so cleanup stays scoped.
import type postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { inject } from 'vitest'
import { $fetch as ofetch, type FetchOptions } from 'ofetch'

declare module 'vitest' {
  export interface ProvidedContext {
    socialAuthUrl: string
    socialAuthPrivateKey: string
    socialPhotoBaseUrl: string
  }
}

// $fetch against this project's server (see global-setup for why it isn't
// @nuxt/test-utils' $fetch).
export function api<T = any>(path: string, opts: FetchOptions<'json'> = {}): Promise<T> {
  return ofetch<T>(path, { baseURL: inject('socialAuthUrl'), ...opts }) as Promise<T>
}

export * from '@nuxtinator/core/test-helpers'

export const TEST_GOOGLE_WEB_CLIENT = 'test-google-web-client'
export const TEST_GOOGLE_IOS_CLIENT = 'test-google-ios-client'
export const TEST_APPLE_BUNDLE = 'org.example.testapp'
export const TEST_KID = 'test-social-key'

export function socialEmail(): string {
  return `test-social-${randomUUID().slice(0, 8)}@example.com`
}

export function googleIdToken(claims: Record<string, unknown>, opts: { aud?: string, iss?: string, kid?: string } = {}): string {
  return jwt.sign(
    { email_verified: true, ...claims },
    inject('socialAuthPrivateKey'),
    {
      algorithm: 'RS256',
      keyid: opts.kid ?? TEST_KID,
      issuer: opts.iss ?? 'https://accounts.google.com',
      audience: opts.aud ?? TEST_GOOGLE_IOS_CLIENT,
      expiresIn: 300
    }
  )
}

export function appleIdToken(claims: Record<string, unknown>): string {
  return jwt.sign(
    { email_verified: 'true', ...claims },
    inject('socialAuthPrivateKey'),
    { algorithm: 'RS256', keyid: TEST_KID, issuer: 'https://appleid.apple.com', audience: TEST_APPLE_BUNDLE, expiresIn: 300 }
  )
}

export async function cleanupSocialTestData(sql: ReturnType<typeof postgres>): Promise<void> {
  await sql`DELETE FROM invites WHERE email LIKE 'test-social-%@example.com' OR display_name LIKE 'test-social-%'`
  await sql`DELETE FROM activity_logs WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'test-social-%@example.com')`
  await sql`DELETE FROM users WHERE email LIKE 'test-social-%@example.com'`
}

// The HTTPS photo host from global-setup.
export function photoUrl(path: string): string {
  return `${inject('socialPhotoBaseUrl')}${path}`
}

// The user's avatar once `ready` accepts it, or whatever it is after `timeoutMs`.
// Provider photos are imported in the background after sign-in.
export async function waitForAvatar(
  sql: ReturnType<typeof postgres>,
  email: string,
  ready: (avatar: string) => boolean,
  timeoutMs = 5000
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const rows = await sql<{ avatar: string }[]>`SELECT avatar FROM users WHERE email = ${email}`
    const avatar = rows[0]?.avatar ?? ''
    if (ready(avatar) || Date.now() > deadline) return avatar
    await new Promise(r => setTimeout(r, 100))
  }
}
