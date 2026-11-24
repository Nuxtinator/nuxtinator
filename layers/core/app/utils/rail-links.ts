import type { AppEntry } from '../composables/useApps'
import { stripOrgPrefix } from './app-match'

export interface RailLink {
  key: string
  appId: string
  title: string
  path: string
  icon?: string
  scope: 'org' | 'user'
  // Carries the app's unread-notification badge.
  badge: boolean
}

// One rail section's links: each app's rail items, or a single link for an app
// that registers none. Apps the org placed (`position`) come first in its
// order, each with its items together; the rest sort together by `order` then
// title. An app's badge goes on its item at the app's own path, else on its
// first item.
export function buildRailLinks(apps: Array<AppEntry & { position?: number | null }>): RailLink[] {
  const links: Array<RailLink & { order: number, rank: number }> = []
  for (const app of apps) {
    const scope = app.scope ?? 'org'
    const rank = app.position ?? Number.MAX_SAFE_INTEGER
    if (!app.rail) {
      links.push({ key: app.id, appId: app.id, title: app.title, path: app.path, icon: app.icon, scope, badge: true, order: app.order ?? 100, rank })
      continue
    }
    const home = stripOrgPrefix(app.path)
    const badgeIndex = Math.max(0, app.rail.findIndex(item => stripOrgPrefix(item.path) === home))
    app.rail.forEach((item, i) => {
      links.push({
        key: `${app.id}:${item.id}`,
        appId: app.id,
        title: item.title,
        path: item.path,
        icon: item.icon,
        scope,
        badge: i === badgeIndex,
        order: item.order ?? 100,
        rank
      })
    })
  }
  return links
    .sort((a, b) => a.rank - b.rank || a.order - b.order || a.title.localeCompare(b.title))
    .map(({ order: _order, rank: _rank, ...link }) => link)
}
