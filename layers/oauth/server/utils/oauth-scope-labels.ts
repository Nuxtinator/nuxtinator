// A requested scope as people read it, for the consent screen, the
// consent-granted email and the connected-apps list. Permission scopes take
// the title and description their layer registered; `offline_access` has its
// own wording.
import { getPermissionMeta } from '#core/server/utils/permissions-registry'
import { getRegisteredApps } from '#core/server/utils/app-registry'
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

export interface OauthScopeGroup {
  key: string
  title: string
  scopes: OauthScopeLabel[]
}

// Scopes grouped by the app they belong to, for the consent screen and the
// connected-apps editor. A scope belongs to the personal app that lists it,
// else to the app whose id is its prefix (`inbox.read` → inbox); one with no
// such app is grouped by its prefix. `offline_access` comes last, on its own.
export function groupScopeLabels(scopes: string[]): OauthScopeGroup[] {
  const apps = getRegisteredApps()
  const appOf = (scope: string) => {
    const prefix = scope.split('.')[0] ?? scope
    const app = apps.find(a => a.permissions?.includes(scope)) ?? apps.find(a => a.id === prefix)
    return app
      ? { key: app.id, title: app.title }
      : { key: prefix, title: prefix.charAt(0).toUpperCase() + prefix.slice(1) }
  }

  const groups = new Map<string, OauthScopeGroup>()
  let offline: OauthScopeGroup | null = null
  for (const scope of scopes) {
    const label = oauthScopeLabel(scope)
    if (scope === OFFLINE_ACCESS_SCOPE) {
      offline = { key: scope, title: label.title, scopes: [label] }
      continue
    }
    const { key, title } = appOf(scope)
    const group = groups.get(key) ?? { key, title, scopes: [] }
    group.scopes.push(label)
    groups.set(key, group)
  }
  return offline ? [...groups.values(), offline] : [...groups.values()]
}
