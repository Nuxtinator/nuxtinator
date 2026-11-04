import type { H3Event } from 'h3'
import { getHeader } from 'h3'
import { signScopedToken, verifyScopedToken, getAuthUser as getCookieAuthUser, type AuthTokenPayload } from '#core/server/utils/auth'

// Scope claim on the bearer tokens this layer mints for the embeddable widget.
// The token is a scoped credential (see #core signScopedToken) — it can never
// act as a full session, only at these widget endpoints.
export const WIDGET_TOKEN_SCOPE = 'feedback'

interface WidgetTokenPayload extends AuthTokenPayload {
  project_id?: string
}

// Mints the widget bearer token. It is bound to the one project the user
// signed in to, so it can't act on any other project's widget endpoints.
export function signWidgetToken(user: AuthTokenPayload, projectId: string): string {
  const payload: WidgetTokenPayload = {
    userId: user.userId,
    email: user.email,
    display_name: user.display_name,
    project_id: projectId
  }
  return signScopedToken(payload, WIDGET_TOKEN_SCOPE, (useRuntimeConfig().feedbackTokenTtl as string) || '30d')
}

// Auth helper for the embeddable web component endpoints. Accepts BOTH the
// `auth-token` cookie (same-origin, in-app usage — a full session) AND
// `Authorization: Bearer <token>` (cross-origin embed), where the bearer is a
// feedback-scoped token the widget obtained via the sign-in flow. A bearer
// token is only accepted for the project it was issued for; `projectId: null`
// is for endpoints that act on no project (the caller's own identity).
export function getWidgetAuthUser(event: H3Event, projectId: string | null) {
  const cookieUser = getCookieAuthUser(event)
  if (cookieUser) return cookieUser

  const authHeader = getHeader(event, 'authorization') || ''
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice(7).trim()
    const decoded = token ? verifyScopedToken(token, WIDGET_TOKEN_SCOPE) as WidgetTokenPayload | null : null
    if (decoded && (projectId === null || decoded.project_id === projectId)) return decoded
  }
  return null
}

export function requireWidgetAuthUser(event: H3Event, projectId: string | null) {
  const user = getWidgetAuthUser(event, projectId)
  if (!user) {
    throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
  }
  return user
}
