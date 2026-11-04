import { db } from '#core/server/utils/database'
import { requireAuth } from '#core/server/utils/auth'
import { runInOrgTransaction } from '#tenant/server'
import { getOauthConfig } from '../../utils/oauth-config'
import { sha256Hex, constantTimeEqual } from '../../utils/oauth-crypto'
import { buildRedirect, hasAnyPermissionScope, parseScopeString } from '../../utils/oauth-validation'
import { choicesFromRow, mergeConsentChoices } from '../../utils/oauth-consent-choices'
import { issueCode } from '../../utils/oauth-issue-code'
import { logOauthEvent, OAUTH_EVENTS } from '../../utils/oauth-audit'

function abort(status: number, message: string): never {
  throw createError({ statusCode: status, statusMessage: message })
}

export default defineEventHandler(async (event) => {
  const user = requireAuth(event)
  const cfg = getOauthConfig()

  const body = await readBody<Record<string, unknown>>(event).catch(() => null)
  const requestId = body?.request_id ? String(body.request_id) : ''
  const action = body?.action ? String(body.action) : ''
  const submittedCsrf = body?.csrf_token ? String(body.csrf_token) : ''
  // The scopes left ticked on the consent screen.
  const ticked = new Set([body?.scope ?? []].flat().map(String))

  if (!requestId || !action) {
    abort(400, 'Missing required fields')
  }
  if (action !== 'approve' && action !== 'deny') {
    abort(400, 'action must be approve or deny')
  }

  // Reads + writes against oauth_pending_requests and oauth_consents are
  // RLS-scoped in multi-tenant mode. Single mode: plain transaction, no GUC.
  // `userId` resolves the org the same way `authorize.get.ts` did, so this
  // step reads the pending row it wrote.
  const { row: pending, chosen } = await runInOrgTransaction(event, { userId: user.userId }, async (tx) => {
    const row = await tx
      .selectFrom('oauth_pending_requests')
      .selectAll()
      .where('id', '=', requestId)
      .executeTakeFirst()

    if (!row) abort(400, 'Request not found')
    if (row.consumed) abort(410, 'Already completed')
    if (new Date(row.expires) < new Date()) abort(410, 'Expired')
    if (row.user_id !== user.userId) abort(400, 'User mismatch')

    // Validate CSRF (constant-time hash compare)
    const submittedHash = sha256Hex(submittedCsrf)
    if (!constantTimeEqual(submittedHash, row.csrf_token_hash)) {
      abort(400, 'Invalid CSRF token')
    }

    // Atomically consume
    const consumed = await tx
      .updateTable('oauth_pending_requests')
      .set({ consumed: true })
      .where('id', '=', requestId)
      .where('consumed', '=', false)
      .returning('id')
      .executeTakeFirst()

    if (!consumed) abort(410, 'Already consumed')

    // Approving with no permission left ticked is a deny.
    const requested = parseScopeString(row.scope)
    const chosen = action === 'approve' ? requested.filter(s => ticked.has(s)) : []
    if (!hasAnyPermissionScope(chosen)) return { row, chosen: null }

    // Upsert consent — must run in the same txn so the GUC scopes the row
    // to the active org via the column DEFAULT. Unticked scopes are kept as
    // declined so the screen doesn't ask about them again.
    const prev = await tx
      .selectFrom('oauth_consents')
      .select(['scope', 'declined_scope'])
      .where('client_id', '=', row.client_id)
      .where('user_id', '=', row.user_id)
      .where('resource', '=', row.resource)
      .where('revoked', '=', false)
      .executeTakeFirst()
    const choices = mergeConsentChoices(choicesFromRow(prev), requested, chosen)
    const saved = {
      scope: choices.granted.join(' '),
      declined_scope: choices.declined.join(' ')
    }
    await tx
      .insertInto('oauth_consents')
      .values({
        client_id: row.client_id,
        user_id: row.user_id,
        resource: row.resource,
        ...saved,
        revoked: false
      })
      .onConflict(oc => oc
        .columns(['client_id', 'user_id', 'resource'])
        .doUpdateSet({
          ...saved,
          revoked: false,
          updated: new Date()
        })
      )
      .execute()

    return { row, chosen }
  })

  // Clear consent cookie
  deleteCookie(event, `oauth_consent_token_${requestId}`, { path: '/oauth/' })

  if (!chosen) {
    logOauthEvent({
      event: OAUTH_EVENTS.CONSENT_DENIED,
      userId: user.userId,
      event3: event,
      metadata: {
        client_id: pending.client_id,
        resource: pending.resource,
        scope: pending.scope
      }
    })
    const params: Record<string, string> = {
      error: 'access_denied',
      iss: cfg.issuer
    }
    if (pending.state) params.state = pending.state
    await sendRedirect(event, buildRedirect(pending.redirect_uri, params))
    return
  }

  const grantedScope = chosen.join(' ')
  logOauthEvent({
    event: OAUTH_EVENTS.CONSENT_GRANTED,
    userId: user.userId,
    event3: event,
    metadata: {
      client_id: pending.client_id,
      resource: pending.resource,
      scope: grantedScope,
      requested: pending.scope
    }
  })

  // Fire `oauth:consent-granted` so the consumer project can react
  // (typically: email the user "X was just connected to your account").
  // Fires only on explicit consent — the auto-issue short-circuit in
  // authorize.get.ts (existing-consent-covers-scope path) does not
  // hit this handler, so silent re-issues do not spam the user.
  //
  // Fetched here (one extra query) so subscribers don't all need to
  // re-resolve the client. Errors in subscribers are swallowed by
  // Nitro's hook runner — a broken email path must never block grant.
  const clientMeta = await db
    .selectFrom('oauth_clients')
    .select(['client_name', 'dynamic'])
    .where('client_id', '=', pending.client_id)
    .executeTakeFirst()

  await useNitroApp().hooks.callHook('oauth:consent-granted', {
    userId: pending.user_id,
    clientId: pending.client_id,
    clientName: clientMeta?.client_name ?? pending.client_id,
    dynamic: Boolean(clientMeta?.dynamic),
    scope: grantedScope,
    resource: pending.resource,
    event
  })

  const { code } = await issueCode({
    clientId: pending.client_id,
    userId: pending.user_id,
    redirectUri: pending.redirect_uri,
    scope: grantedScope,
    resource: pending.resource,
    codeChallenge: pending.code_challenge,
    event
  })

  const params: Record<string, string> = {
    code,
    iss: cfg.issuer
  }
  if (pending.state) params.state = pending.state
  await sendRedirect(event, buildRedirect(pending.redirect_uri, params))
})
