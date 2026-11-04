import type { H3Event } from 'h3'
import { logEvent } from '#core/server/utils/activity-logger'
import { getClientIp } from '#core/server/utils/client-ip'

export const OAUTH_EVENTS = {
  CLIENT_REGISTERED: 'oauth.client_registered',
  CLIENT_ENABLED: 'oauth.client_enabled',
  CLIENT_DISABLED: 'oauth.client_disabled',
  CONSENT_GRANTED: 'oauth.consent_granted',
  CONSENT_DENIED: 'oauth.consent_denied',
  CONSENT_REVOKED: 'oauth.consent_revoked',
  CONSENT_UPDATED: 'oauth.consent_updated',
  SCOPE_REDUCED: 'oauth.scope_reduced',
  AUTHORIZE_ORG_UNRESOLVED: 'oauth.authorize_org_unresolved',
  AUTHORIZATION_CODE_ISSUED: 'oauth.authorization_code_issued',
  AUTHORIZATION_CODE_REUSED: 'oauth.authorization_code_reused',
  TOKEN_ISSUED: 'oauth.token_issued',
  TOKEN_DENIED: 'oauth.token_denied',
  REFRESH_ROTATED: 'oauth.refresh_rotated',
  REFRESH_REUSED: 'oauth.refresh_reused',
  TOKEN_REVOKED: 'oauth.token_revoked',
  TOKEN_ISSUANCE_ABORTED_FAMILY_REVOKED: 'oauth.token_issuance_aborted_family_revoked',
  FAMILY_REVOKED_BY_ADMIN: 'oauth.family_revoked_by_admin'
} as const

interface OauthLogOptions {
  event: string
  userId?: string
  event3?: H3Event | null
  metadata?: Record<string, unknown>
}

// Never include token material (plaintext or hash) in metadata.
// Safe to include: client_id, user_id, resource, scope, family_id, reasons, ids (non-secret UUID).
//
// IP is captured into metadata.ip when an H3Event is supplied so abuse
// forensics ("which IP replayed this code/refresh token?") work without
// per-call boilerplate. Caller-supplied metadata.ip wins (the DCR route
// computes its own and passes it explicitly).
export function logOauthEvent(options: OauthLogOptions): void {
  const userAgent = options.event3 ? (getHeader(options.event3, 'user-agent') || undefined) : undefined
  const ip = options.event3 ? getClientIp(options.event3) : undefined
  const metadata = ip
    ? { ip, ...(options.metadata ?? {}) }
    : (options.metadata ?? {})
  logEvent({
    eventType: options.event,
    userId: options.userId,
    userAgent,
    metadata
  })
}
