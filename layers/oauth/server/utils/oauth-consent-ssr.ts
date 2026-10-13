import type { H3Event } from 'h3'
import { db } from '#core/server/utils/database'
import { getAuthUser } from '#core/server/utils/auth'
import { runInOrgTransaction } from '#tenant/server'
import { getOauthConfig } from './oauth-config'
import { verifyCookiePayload } from './oauth-crypto'
import { parseScopeString } from './oauth-validation'
import { oauthScopeLabel, type OauthScopeLabel } from './oauth-scope-labels'

export interface ConsentViewModel {
  status: 'ok' | 'not_found' | 'wrong_user' | 'consumed' | 'expired' | 'missing_csrf' | 'unauthorized'
  requestId?: string
  clientName?: string
  clientDynamic?: boolean
  scopeItems?: OauthScopeLabel[]
  csrfToken?: string
}

export async function loadConsentView(event: H3Event, requestId: string): Promise<ConsentViewModel> {
  const authUser = getAuthUser(event)
  if (!authUser) return { status: 'unauthorized' }

  // RLS-scoped in multi mode (oauth_pending_requests has org_id + policy).
  // Single mode: plain transaction. `userId` resolves the org the same way
  // `authorize.get.ts` did, so this read sees the pending row it wrote.
  const pending = await runInOrgTransaction(event, { userId: authUser.userId }, async (tx) => {
    return await tx
      .selectFrom('oauth_pending_requests')
      .selectAll()
      .where('id', '=', requestId)
      .executeTakeFirst()
  })

  if (!pending) return { status: 'not_found' }
  if (pending.user_id !== authUser.userId) return { status: 'not_found' }
  if (pending.consumed) return { status: 'consumed' }
  if (new Date(pending.expires) < new Date()) return { status: 'expired' }

  const cfg = getOauthConfig()
  const cookieName = `oauth_consent_token_${requestId}`
  const signed = getCookie(event, cookieName)
  if (!signed) return { status: 'missing_csrf' }
  const payload = verifyCookiePayload<{ rid: string, csrf: string, exp: number }>(signed, cfg.consentCookieSecret)
  if (!payload || payload.rid !== requestId) return { status: 'missing_csrf' }
  if (payload.exp < Date.now()) return { status: 'missing_csrf' }

  const client = await db
    .selectFrom('oauth_clients')
    .select(['client_name', 'dynamic'])
    .where('client_id', '=', pending.client_id)
    .executeTakeFirst()

  const scopes = parseScopeString(pending.scope)
  const scopeItems = scopes.map(oauthScopeLabel)

  return {
    status: 'ok',
    requestId,
    clientName: client?.client_name || pending.client_id,
    clientDynamic: Boolean(client?.dynamic),
    scopeItems,
    csrfToken: payload.csrf
  }
}
