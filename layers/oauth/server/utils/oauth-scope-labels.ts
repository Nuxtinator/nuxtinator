// A requested scope as people read it, for the consent screen, the
// consent-granted email and the connected-apps list. Permission scopes take
// the title and description their layer registered; `offline_access` has its
// own wording.
import { getPermissionMeta } from '#core/server/utils/permissions-registry'
import { OFFLINE_ACCESS_SCOPE } from './oauth-validation'

export interface OauthScopeLabel {
  scope: string
  title: string
  description: string
}

export function oauthScopeLabel(scope: string): OauthScopeLabel {
  if (scope === OFFLINE_ACCESS_SCOPE) {
    return { scope, title: 'Stay connected', description: 'Maintain access when you are not actively using the client (refresh tokens)' }
  }
  const meta = getPermissionMeta(scope)
  return { scope, title: meta?.title || scope, description: meta?.description || '' }
}
