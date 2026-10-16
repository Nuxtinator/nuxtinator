import { createHash, createPublicKey, randomBytes, type KeyObject, type webcrypto } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { getSiteUrl } from '#core/server/utils/site-url'

// Google and Apple as OpenID Connect providers: configuration, the web
// authorization request, the code exchange, and ID-token verification.

export type SocialProviderId = 'google' | 'apple'

export interface SocialProfile {
  subject: string
  email: string | null
  emailVerified: boolean
  name: string | null
  picture: string | null
}

export interface ProviderConfig {
  id: SocialProviderId
  label: string
  icon: string
  issuers: string[]
  jwksUrl: string
  webClientId: string
  // Audiences accepted for ID tokens sent directly by native apps.
  nativeAudiences: string[]
  webEnabled: boolean
  nativeEnabled: boolean
  // Hosts (and their subdomains) the provider's profile photos may be fetched from.
  photoHosts: string[]
}

function list(value: unknown): string[] {
  return String(value ?? '').split(',').map(s => s.trim()).filter(Boolean)
}

function settings() {
  return useRuntimeConfig().socialAuth as {
    google: { clientId: string, clientSecret: string, nativeClientIds: string, jwksUrl: string, photoHosts: string }
    apple: { servicesId: string, teamId: string, keyId: string, privateKey: string, bundleIds: string, jwksUrl: string }
  }
}

export function getProviderConfig(id: string): ProviderConfig | null {
  const s = settings()
  if (id === 'google') {
    const g = s.google
    const nativeIds = list(g.nativeClientIds)
    return {
      id: 'google',
      label: 'Google',
      icon: 'i-simple-icons-google',
      issuers: ['https://accounts.google.com', 'accounts.google.com'],
      jwksUrl: g.jwksUrl || 'https://www.googleapis.com/oauth2/v3/certs',
      webClientId: g.clientId,
      // Android apps request ID tokens for the web client ID, so it's accepted too.
      nativeAudiences: [...nativeIds, ...(g.clientId ? [g.clientId] : [])],
      webEnabled: !!(g.clientId && g.clientSecret),
      nativeEnabled: nativeIds.length > 0 || !!g.clientId,
      photoHosts: g.photoHosts ? list(g.photoHosts) : ['googleusercontent.com']
    }
  }
  if (id === 'apple') {
    const a = s.apple
    const signing = !!(a.teamId && a.keyId && a.privateKey)
    const bundleIds = list(a.bundleIds)
    return {
      id: 'apple',
      label: 'Apple',
      icon: 'i-simple-icons-apple',
      issuers: ['https://appleid.apple.com'],
      jwksUrl: a.jwksUrl || 'https://appleid.apple.com/auth/keys',
      webClientId: a.servicesId,
      nativeAudiences: bundleIds,
      webEnabled: !!(a.servicesId && signing),
      nativeEnabled: bundleIds.length > 0,
      // Apple sends no profile photo.
      photoHosts: []
    }
  }
  return null
}

export function callbackUrl(id: SocialProviderId): string {
  return `${getSiteUrl()}/api/social-auth/${id}/callback`
}

export function randomToken(): string {
  return randomBytes(32).toString('base64url')
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export function authorizationUrl(
  cfg: ProviderConfig,
  params: { state: string, nonce: string, codeVerifier: string }
): string {
  if (cfg.id === 'google') {
    const q = new URLSearchParams({
      client_id: cfg.webClientId,
      redirect_uri: callbackUrl('google'),
      response_type: 'code',
      scope: 'openid email profile',
      state: params.state,
      nonce: params.nonce,
      code_challenge: pkceChallenge(params.codeVerifier),
      code_challenge_method: 'S256',
      prompt: 'select_account'
    })
    return `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`
  }
  // Apple returns to the callback as a cross-site form POST when name/email
  // scopes are requested; the POST handler hands it on to the GET handler.
  const q = new URLSearchParams({
    client_id: cfg.webClientId,
    redirect_uri: callbackUrl('apple'),
    response_type: 'code',
    response_mode: 'form_post',
    scope: 'name email',
    state: params.state,
    nonce: params.nonce
  })
  return `https://appleid.apple.com/auth/authorize?${q.toString()}`
}

// The client secret Apple expects: a short-lived ES256 JWT signed with the
// team's private key, issued for the client (Services ID or bundle ID) that
// is talking to Apple.
export function appleClientSecret(clientId: string): string {
  const a = settings().apple
  const key = a.privateKey.replace(/\\n/g, '\n')
  return jwt.sign({}, key, {
    algorithm: 'ES256',
    keyid: a.keyId,
    issuer: a.teamId,
    audience: 'https://appleid.apple.com',
    subject: clientId,
    expiresIn: 300
  })
}

export interface CodeExchangeResult {
  idToken: string
  refreshToken: string | null
}

// Exchanges an authorization code. `clientId` defaults to the web client; a
// native Apple sign-in exchanges its code with the app's bundle ID.
export async function exchangeCode(
  cfg: ProviderConfig,
  code: string,
  opts: { codeVerifier?: string, clientId?: string, redirectUri?: string | null } = {}
): Promise<CodeExchangeResult> {
  const clientId = opts.clientId ?? cfg.webClientId
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId })
  if (opts.redirectUri !== null) body.set('redirect_uri', opts.redirectUri ?? callbackUrl(cfg.id))

  let url: string
  if (cfg.id === 'google') {
    url = 'https://oauth2.googleapis.com/token'
    body.set('client_secret', settings().google.clientSecret)
    if (opts.codeVerifier) body.set('code_verifier', opts.codeVerifier)
  } else {
    url = 'https://appleid.apple.com/auth/token'
    body.set('client_secret', appleClientSecret(clientId))
  }

  const res = await $fetch<{ id_token?: string, refresh_token?: string }, string>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  })
  if (!res?.id_token) throw new Error(`${cfg.id} token response had no id_token`)
  return { idToken: res.id_token, refreshToken: res.refresh_token ?? null }
}

export async function revokeAppleToken(clientId: string, refreshToken: string): Promise<void> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: appleClientSecret(clientId),
    token: refreshToken,
    token_type_hint: 'refresh_token'
  })
  await $fetch<void, string>('https://appleid.apple.com/auth/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  })
}

// ---------- ID-token verification ----------

const JWKS_TTL_MS = 60 * 60 * 1000
const jwksCache = new Map<string, { at: number, keys: Map<string, KeyObject> }>()

async function loadJwks(url: string, force = false): Promise<Map<string, KeyObject>> {
  const cached = jwksCache.get(url)
  if (cached && !force && Date.now() - cached.at < JWKS_TTL_MS) return cached.keys
  const res = await $fetch<{ keys: Array<webcrypto.JsonWebKey & { kid?: string }> }, string>(url)
  const keys = new Map<string, KeyObject>()
  for (const jwk of res.keys ?? []) {
    if (jwk.kid) keys.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }))
  }
  jwksCache.set(url, { at: Date.now(), keys })
  return keys
}

async function signingKey(url: string, kid: string): Promise<KeyObject | null> {
  let keys = await loadJwks(url)
  if (!keys.has(kid)) keys = await loadJwks(url, true)
  return keys.get(kid) ?? null
}

// Verifies signature, issuer, audience and expiry, and — when `nonce` is
// given — that the token carries it (raw, or SHA-256 hex as Apple's native
// SDK sends it). Returns the profile, or null if anything fails.
export async function verifyIdToken(
  cfg: ProviderConfig,
  idToken: string,
  audiences: string[],
  nonce: string | null
): Promise<SocialProfile | null> {
  if (audiences.length === 0) return null
  const decoded = jwt.decode(idToken, { complete: true })
  const kid = decoded && typeof decoded === 'object' ? decoded.header.kid : undefined
  if (!kid) return null

  const key = await signingKey(cfg.jwksUrl, kid)
  if (!key) return null

  let claims: Record<string, any>
  try {
    claims = jwt.verify(idToken, key, {
      algorithms: ['RS256', 'ES256'],
      issuer: cfg.issuers as [string, ...string[]],
      audience: audiences as [string, ...string[]]
    }) as Record<string, any>
  } catch {
    return null
  }

  if (nonce !== null) {
    if (claims.nonce !== nonce && claims.nonce !== sha256Hex(nonce)) return null
  } else if (claims.nonce) {
    return null
  }

  if (typeof claims.sub !== 'string' || !claims.sub) return null
  const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : null
  const name = typeof claims.name === 'string' && claims.name.trim().length >= 2 ? claims.name.trim() : null
  return {
    subject: claims.sub,
    email,
    // Apple sends booleans as strings.
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    name,
    picture: typeof claims.picture === 'string' ? claims.picture : null
  }
}
