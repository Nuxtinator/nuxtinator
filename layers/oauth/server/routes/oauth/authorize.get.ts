import { sql } from 'kysely'
import { db } from '#core/server/utils/database'
import { getAuthUser } from '#core/server/utils/auth'
import { runInOrgTransaction, getUserPermissionsAcrossOrgs } from '#tenant/server'
import { consumeRateLimit, logRateLimitExceeded } from '#core/server/utils/rate-limit'
import { getOauthConfig } from '../../utils/oauth-config'
import {
  isValidS256Challenge,
  newCsrfToken,
  sha256Hex,
  signCookiePayload
} from '../../utils/oauth-crypto'
import {
  buildRedirect,
  parseRedirectUri,
  matchesRegisteredRedirect,
  filterScopesByPermissions,
  getAdvertisedScopes,
  hasAnyPermissionScope,
  isScopeSubset,
  parseScopeString
} from '../../utils/oauth-validation'
import { logOauthEvent, OAUTH_EVENTS } from '../../utils/oauth-audit'
import { choicesCover, choicesFromRow } from '../../utils/oauth-consent-choices'
import type { H3Event } from 'h3'
import { getClientIp } from '#core/server/utils/client-ip'

function sendHtmlError(event: H3Event, status: number, title: string, message: string): string {
  setResponseStatus(event, status)
  setResponseHeader(event, 'content-type', 'text/html; charset=utf-8')
  return `<!doctype html><html><head><title>${title}</title></head><body style="font-family:system-ui;max-width:560px;margin:4rem auto;padding:0 1rem"><h1>${title}</h1><p>${message}</p></body></html>`
}

export default defineEventHandler(async (event) => {
  const cfg = getOauthConfig()
  const ip = getClientIp(event)
  const userAgent = getHeader(event, 'user-agent') || undefined

  // Counts and records in one locked step, so parallel requests can't all pass.
  // Kept under the `ratelimit.*` namespace (not `oauth.*`) so it's prunable
  // bookkeeping, not an audit event in the events view.
  const rate = await consumeRateLimit('ratelimit.oauth.authorize', 'ip', ip, 60 * 1000, 60)
  if (!rate.allowed) {
    logRateLimitExceeded(ip, '/oauth/authorize', userAgent)
    setResponseStatus(event, 429)
    if (rate.retryAfterSeconds) setResponseHeader(event, 'Retry-After', rate.retryAfterSeconds)
    return 'Rate limit exceeded'
  }

  const q = getQuery(event) as Record<string, string | string[] | undefined>
  const pick = (k: string): string | undefined => {
    const v = q[k]
    if (Array.isArray(v)) return v[0]
    return v
  }

  const responseType = pick('response_type')
  const responseMode = pick('response_mode')
  const clientIdParam = pick('client_id')
  const redirectUriRaw = pick('redirect_uri')
  const scopeParam = pick('scope') ?? ''
  const state = pick('state') ?? null
  const codeChallenge = pick('code_challenge')
  const codeChallengeMethod = pick('code_challenge_method')
  const resourceParam = pick('resource')

  // Tier 1: untrusted-redirect-target errors → server HTML 400.
  if (!clientIdParam) {
    return sendHtmlError(event, 400, 'Invalid authorization request', 'Missing <code>client_id</code>.')
  }
  const client = await db
    .selectFrom('oauth_clients')
    .selectAll()
    .where('client_id', '=', clientIdParam)
    .executeTakeFirst()
  if (!client || !client.enabled) {
    return sendHtmlError(event, 400, 'Invalid authorization request', 'The requested client is not registered or has been disabled.')
  }

  if (!redirectUriRaw) {
    return sendHtmlError(event, 400, 'Invalid authorization request', 'Missing <code>redirect_uri</code>.')
  }
  const parsedRedirect = parseRedirectUri(redirectUriRaw)
  if (!parsedRedirect.valid || !parsedRedirect.serialized) {
    return sendHtmlError(event, 400, 'Invalid authorization request', `<code>redirect_uri</code> is invalid: ${parsedRedirect.error}`)
  }
  const normalizedRedirect = parsedRedirect.serialized
  // RFC 8252 §7.3: loopback URIs match across ports — see
  // matchesRegisteredRedirect for the fuzzy semantics. Non-loopback
  // URIs still require exact-string match against the registered set.
  if (!matchesRegisteredRedirect(normalizedRedirect, client.redirect_uris)) {
    return sendHtmlError(event, 400, 'Invalid authorization request', 'The provided <code>redirect_uri</code> is not registered for this client.')
  }

  if (responseType !== 'code') {
    return sendHtmlError(event, 400, 'Invalid authorization request', 'Only <code>response_type=code</code> is supported.')
  }
  if (responseMode && responseMode !== 'query') {
    return sendHtmlError(event, 400, 'Invalid authorization request', 'Only <code>response_mode=query</code> is supported.')
  }

  // From here, errors can safely redirect back to the validated redirect URI.
  const errRedirect = (err: string, desc?: string): string => {
    const params: Record<string, string> = { error: err, iss: cfg.issuer }
    if (desc) params.error_description = desc
    if (state) params.state = state
    return buildRedirect(normalizedRedirect, params)
  }

  // RFC 6749 doesn't bound `state`, but we store it in oauth_pending_requests
  // and echo it on the redirect — uncapped strings are a free DoS / DB-bloat
  // vector. 2 KB is well above any sane client (most use 16-32 byte nonces).
  if (state !== null && state.length > 2048) {
    await sendRedirect(event, errRedirect('invalid_request', 'state exceeds 2048 characters'))
    return
  }

  // PKCE
  if (codeChallengeMethod !== 'S256') {
    await sendRedirect(event, errRedirect('invalid_request', 'code_challenge_method must be S256'))
    return
  }
  if (!codeChallenge || !isValidS256Challenge(codeChallenge)) {
    await sendRedirect(event, errRedirect('invalid_request', 'code_challenge missing or malformed'))
    return
  }

  // Resource
  if (!resourceParam || resourceParam !== cfg.mcpResource) {
    await sendRedirect(event, errRedirect('invalid_target', 'resource parameter missing or does not match'))
    return
  }

  // Must be logged in — if not, redirect to login page with resume URL. The
  // login page resumes with a client-side navigation, which can't reach this
  // server route, so it resumes through the /oauth/continue page, which
  // reloads this URL for real.
  const url = getRequestURL(event)
  const self = url.pathname + url.search
  const authUser = getAuthUser(event)
  if (!authUser) {
    const resumeUrl = `${cfg.loginPath}?redirect=${encodeURIComponent(`/oauth/continue?to=${encodeURIComponent(self)}`)}`
    await sendRedirect(event, resumeUrl)
    return
  }

  // Scope: requested must be subset of client cap, then intersect with user RBAC.
  // A dynamically registered client chose its own scope at registration and
  // could re-register for any advertised scope, so its cap is the advertised
  // set. Otherwise every scope added after it registered (a new layer's tools)
  // would fail it with invalid_scope. Admin-registered clients keep their cap.
  const requestedScopes = parseScopeString(scopeParam)
  const clientCap = client.dynamic ? getAdvertisedScopes() : parseScopeString(client.scope)
  if (requestedScopes.length === 0 || !isScopeSubset(requestedScopes, clientCap)) {
    await sendRedirect(event, errRedirect('invalid_scope', 'Requested scope is empty or not permitted for this client'))
    return
  }

  const userPerms = await getUserPermissionsAcrossOrgs(authUser.userId)
  const grantedScopes = filterScopesByPermissions(requestedScopes, userPerms)
  if (grantedScopes.length !== requestedScopes.length) {
    logOauthEvent({
      event: OAUTH_EVENTS.SCOPE_REDUCED,
      userId: authUser.userId,
      event3: event,
      metadata: {
        client_id: client.client_id,
        requested: requestedScopes.join(' '),
        granted: grantedScopes.join(' ')
      }
    })
  }

  if (!hasAnyPermissionScope(grantedScopes)) {
    await sendRedirect(event, errRedirect('invalid_scope', 'No permission scope can be granted for this user'))
    return
  }

  // CSRF synchronizer token — declared outside the txn since the cookie is
  // set after.
  const csrfPlaintext = newCsrfToken()

  // The next two operations touch RLS-protected tables (oauth_consents,
  // oauth_pending_requests). In multi-tenant mode we open a transaction with
  // `app.current_org` set so RLS scopes correctly and the DEFAULT picks up
  // the active org for the pending-request INSERT. Single mode: just a plain
  // transaction (no GUC, no RLS).
  //
  // `userId` is what lets the org resolve at all here: this endpoint is a
  // browser navigation on a non-`/api/` path, so it carries no `X-Active-Org`
  // header and the tenancy middleware never populates `event.context`. That
  // leaves the `active-org-slug` cookie, which is unset until some other
  // org-scoped request has written it. Passing the user lets the kernel fall
  // back to their sole membership, and lets a stale cookie fall back too.
  let pendingRequestId: string | null
  // Scopes an existing consent already answers, when it answers them all.
  let consentedScopes: string[] = []
  try {
    pendingRequestId = await runInOrgTransaction(event, { userId: authUser.userId }, async (tx) => {
      // Existing consent short-circuit: the user already said yes or no to
      // every requested scope, and said yes to at least one permission.
      const existingConsent = await tx
        .selectFrom('oauth_consents')
        .selectAll()
        .where('client_id', '=', client.client_id)
        .where('user_id', '=', authUser.userId)
        .where('resource', '=', cfg.mcpResource)
        .where('revoked', '=', false)
        .executeTakeFirst()

      const choices = choicesFromRow(existingConsent)
      if (choices && choicesCover(choices, grantedScopes)) {
        const previouslyGranted = grantedScopes.filter(s => choices.granted.includes(s))
        if (hasAnyPermissionScope(previouslyGranted)) {
          consentedScopes = previouslyGranted
          return null // Signals the caller to issue a code directly.
        }
      }

      const csrfHash = sha256Hex(csrfPlaintext)
      const pendingRow = await tx
        .insertInto('oauth_pending_requests')
        .values({
          expires: sql<Date>`now() + interval '${sql.raw(String(cfg.pendingRequestTtl))} seconds'`,
          client_id: client.client_id,
          user_id: authUser.userId,
          redirect_uri: normalizedRedirect,
          scope: grantedScopes.join(' '),
          resource: cfg.mcpResource,
          state,
          code_challenge: codeChallenge,
          csrf_token_hash: csrfHash
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      return pendingRow.id
    })
  } catch (err) {
    // The kernel rejects an unresolvable org with a 4xx: the user belongs to
    // no active org, or to several with nothing selecting one. The second is
    // sent to the org picker; the rest are reported to the client as an OAuth
    // error instead of rendering as an error page mid-flow. Anything else (a
    // DB fault) propagates.
    const status = (err as { statusCode?: number }).statusCode
    if (typeof status !== 'number' || status < 400 || status >= 500) throw err
    // 400 = nothing selected an org. Let the user pick one on /oauth/continue,
    // which sets the active-org cookie this request resolves the org from.
    if (status === 400) {
      await sendRedirect(event, `/oauth/continue?pick_org=1&to=${encodeURIComponent(self)}`)
      return
    }
    logOauthEvent({
      event: OAUTH_EVENTS.AUTHORIZE_ORG_UNRESOLVED,
      userId: authUser.userId,
      event3: event,
      metadata: { client_id: client.client_id, status }
    })
    const desc = (err as { statusMessage?: string }).statusMessage
      || 'No organization could be resolved for this authorization'
    await sendRedirect(event, errRedirect('access_denied', desc))
    return
  }

  if (pendingRequestId === null) {
    // Skip consent UI — issue a code directly.
    const { issueCode } = await import('../../utils/oauth-issue-code')
    const { code } = await issueCode({
      clientId: client.client_id,
      userId: authUser.userId,
      redirectUri: normalizedRedirect,
      scope: consentedScopes.join(' '),
      resource: cfg.mcpResource,
      codeChallenge,
      event
    })
    const params: Record<string, string> = { code, iss: cfg.issuer }
    if (state) params.state = state
    await sendRedirect(event, buildRedirect(normalizedRedirect, params))
    return
  }

  // CSRF plaintext goes in the signed cookie below.
  const pendingRow = { id: pendingRequestId }

  // Signed HttpOnly cookie carries the CSRF plaintext to the consent SSR. Lax,
  // not Strict: a native app or CLI opens this flow from outside the browser,
  // and Chrome withholds Strict cookies for the whole redirect chain of such a
  // navigation. Lax is still never sent on a cross-site POST, and the consent
  // POST checks the token against this cookie.
  const cookieValue = signCookiePayload(
    { rid: pendingRow.id, csrf: csrfPlaintext, exp: Date.now() + cfg.pendingRequestTtl * 1000 },
    cfg.consentCookieSecret
  )
  setCookie(event, `oauth_consent_token_${pendingRow.id}`, cookieValue, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/oauth/',
    maxAge: cfg.pendingRequestTtl
  })

  await sendRedirect(event, `/oauth/consent?request_id=${pendingRow.id}`)
})
