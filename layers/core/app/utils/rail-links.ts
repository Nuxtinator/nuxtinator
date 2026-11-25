import type { AppEntry } from '../composables/useApps'
import { arrangeApps, type AppCategoryInfo, type AppLayout } from './app-layout'
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

// One heading's links. `title` is empty when the rail isn't split into
// categories.
export interface RailSection {
  id: string
  title: string
  links: RailLink[]
}

type PlacedApp = AppEntry & { position?: number | null }
type SortableLink = RailLink & { category?: string, order: number, rank: number }

const UNPLACED = Number.MAX_SAFE_INTEGER

// An app's rail items, or a single link for an app that registers none. The
// app's badge goes on its item at the app's own path, else on its first item.
function appLinks(app: PlacedApp): SortableLink[] {
  const scope = app.scope ?? 'org'
  const rank = app.position ?? UNPLACED
  if (!app.rail) {
    return [{ key: app.id, appId: app.id, title: app.title, path: app.path, icon: app.icon, scope, badge: true, order: app.order ?? 100, rank }]
  }
  const home = stripOrgPrefix(app.path)
  const badgeIndex = Math.max(0, app.rail.findIndex(item => stripOrgPrefix(item.path) === home))
  return app.rail.map((item, i) => ({
    key: `${app.id}:${item.id}`,
    appId: app.id,
    title: item.title,
    path: item.path,
    icon: item.icon,
    scope,
    badge: i === badgeIndex,
    category: item.category,
    order: item.order ?? 100,
    rank
  }))
}

function sortLinks(links: SortableLink[]): RailLink[] {
  return links
    .sort((a, b) => a.rank - b.rank || a.order - b.order || a.title.localeCompare(b.title))
    .map(({ category: _category, order: _order, rank: _rank, ...link }) => link)
}

// One rail section's links. Apps the org placed (`position`) come first in
// its order, each with its items together; the rest sort together by `order`
// then title.
export function buildRailLinks(apps: PlacedApp[]): RailLink[] {
  return sortLinks(apps.flatMap(appLinks))
}

// The org's rail under category headings, in the org's arrangement. A rail
// item that names a known category sits under that heading instead of its
// app's, after the apps the org placed there. One untitled section when
// everything lands under one heading.
export function buildRailSections(apps: AppEntry[], categories: AppCategoryInfo[], layout: AppLayout): RailSection[] {
  const arranged = arrangeApps(apps, categories, layout, { includeEmpty: true })
  const byCategory = new Map(arranged.map(c => [c.id, [] as SortableLink[]]))
  for (const category of arranged) {
    for (const app of category.apps) {
      for (const link of appLinks(app)) {
        const elsewhere = link.category && link.category !== category.id ? byCategory.get(link.category) : undefined
        if (elsewhere) elsewhere.push({ ...link, rank: UNPLACED })
        else byCategory.get(category.id)!.push(link)
      }
    }
  }
  const sections = arranged
    .map(c => ({ id: c.id, title: c.title, links: sortLinks(byCategory.get(c.id)!) }))
    .filter(s => s.links.length > 0)
  if (sections.length > 1) return sections
  return [{ id: 'all', title: '', links: sections[0]?.links ?? [] }]
}
