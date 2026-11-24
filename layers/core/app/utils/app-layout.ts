// How org apps are grouped and ordered in the rail, the launcher and the
// dashboard. Code declares the categories and each app's category
// (server/utils/app-categories.ts); an org's changes go on top as an
// `AppLayout`, one `core_settings` value. Only what the org changed is stored,
// so an app installed later lands in its own category, after the apps the org
// has ordered.

export const MORE_CATEGORY = 'more'

export interface AppCategoryInfo {
  id: string
  title: string
}

export interface AppLayout {
  // Category ids in the org's order; the rest follow in code order.
  categories: string[]
  // Titles the org gave categories, including the ones it made.
  titles: Record<string, string>
  // Categories the org made.
  custom: string[]
  // Per category, app ids in the org's order. Listing an app puts it there.
  apps: Record<string, string[]>
}

export interface ArrangeableApp {
  id: string
  title: string
  category?: string
  order?: number
}

export type ArrangedApp<T> = T & {
  // Index in the org's list for the category; null when the org never ordered it.
  position: number | null
}

export interface ArrangedCategory<T> {
  id: string
  title: string
  // The code title; null for a category the org made.
  defaultTitle: string | null
  custom: boolean
  apps: ArrangedApp<T>[]
}

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/
const MAX_TITLE = 60
const MAX_CATEGORIES = 50
const MAX_APPS = 200

export function emptyAppLayout(): AppLayout {
  return { categories: [], titles: {}, custom: [], apps: {} }
}

export function isEmptyAppLayout(layout: AppLayout): boolean {
  return layout.categories.length === 0
    && layout.custom.length === 0
    && Object.keys(layout.titles).length === 0
    && Object.keys(layout.apps).length === 0
}

function ids(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((v): v is string => typeof v === 'string' && ID.test(v)))].slice(0, max)
}

// Coerces a stored or submitted value to a well-formed layout. An app listed
// under two categories keeps the first.
export function parseAppLayout(value: unknown): AppLayout {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const titles: Record<string, string> = {}
  if (v.titles && typeof v.titles === 'object') {
    for (const [id, title] of Object.entries(v.titles as Record<string, unknown>).slice(0, MAX_CATEGORIES)) {
      if (ID.test(id) && typeof title === 'string' && title.trim()) titles[id] = title.trim().slice(0, MAX_TITLE)
    }
  }
  const apps: Record<string, string[]> = {}
  const seen = new Set<string>()
  if (v.apps && typeof v.apps === 'object') {
    for (const [id, list] of Object.entries(v.apps as Record<string, unknown>).slice(0, MAX_CATEGORIES)) {
      if (!ID.test(id)) continue
      const kept = ids(list, MAX_APPS).filter(appId => !seen.has(appId))
      kept.forEach(appId => seen.add(appId))
      if (kept.length) apps[id] = kept
    }
  }
  return {
    categories: ids(v.categories, MAX_CATEGORIES),
    titles,
    custom: ids(v.custom, MAX_CATEGORIES),
    apps
  }
}

// Groups apps by category, in the org's order. Apps the org placed come first
// in its order; the rest follow by `order`, then title. Empty categories are
// left out unless `includeEmpty`.
export function arrangeApps<T extends ArrangeableApp>(
  apps: T[],
  categories: AppCategoryInfo[],
  layout: AppLayout,
  opts: { includeEmpty?: boolean } = {}
): ArrangedCategory<T>[] {
  const code = new Map(categories.map(c => [c.id, c]))
  if (!code.has(MORE_CATEGORY)) code.set(MORE_CATEGORY, { id: MORE_CATEGORY, title: 'More' })
  const custom = layout.custom.filter(id => !code.has(id))
  const known = new Set([...code.keys(), ...custom])
  const listed = layout.categories.filter(id => known.has(id))
  const rest = [...[...code.keys()].filter(id => id !== MORE_CATEGORY), ...custom, MORE_CATEGORY]
    .filter(id => !listed.includes(id))

  const groups = new Map<string, ArrangedCategory<T>>()
  for (const id of [...listed, ...rest]) {
    const defaultTitle = code.get(id)?.title ?? null
    groups.set(id, {
      id,
      title: layout.titles[id] ?? defaultTitle ?? 'Untitled',
      defaultTitle,
      custom: defaultTitle === null,
      apps: []
    })
  }

  for (const app of apps) {
    let category: string | null = null
    let position: number | null = null
    for (const id of groups.keys()) {
      const i = layout.apps[id]?.indexOf(app.id) ?? -1
      if (i >= 0) {
        category = id
        position = i
        break
      }
    }
    if (category === null) category = app.category && code.has(app.category) ? app.category : MORE_CATEGORY
    groups.get(category)!.apps.push({ ...app, position })
  }

  const rank = (p: number | null) => p ?? Number.MAX_SAFE_INTEGER
  for (const group of groups.values()) {
    group.apps.sort((a, b) => rank(a.position) - rank(b.position)
      || (a.order ?? 100) - (b.order ?? 100)
      || a.title.localeCompare(b.title))
  }
  return [...groups.values()].filter(g => opts.includeEmpty || g.apps.length > 0)
}

// Puts an app at `index` in category `to`, given the current arrangement. The
// whole resulting order of `to` is stored, and the app leaves any other list.
export function layoutWithAppMoved(
  layout: AppLayout,
  arranged: ArrangedCategory<ArrangeableApp>[],
  appId: string,
  to: string,
  index: number
): AppLayout {
  const target = arranged.find(c => c.id === to)
  if (!target) return layout
  const order = target.apps.map(a => a.id).filter(id => id !== appId)
  order.splice(Math.max(0, Math.min(index, order.length)), 0, appId)
  const apps: Record<string, string[]> = {}
  for (const [id, list] of Object.entries(layout.apps)) {
    const kept = list.filter(a => a !== appId)
    if (kept.length) apps[id] = kept
  }
  apps[to] = order
  return { ...layout, apps }
}

// Puts a category at `index` among all categories and stores the whole order.
export function layoutWithCategoryMoved(
  layout: AppLayout,
  arranged: ArrangedCategory<unknown>[],
  id: string,
  index: number
): AppLayout {
  const order = arranged.map(c => c.id).filter(c => c !== id)
  if (order.length === arranged.length) return layout
  order.splice(Math.max(0, Math.min(index, order.length)), 0, id)
  return { ...layout, categories: order }
}

// A built-in category's title is stored only while it differs from the code's.
export function layoutWithCategoryTitle(layout: AppLayout, category: ArrangedCategory<unknown>, title: string): AppLayout {
  const trimmed = title.trim().slice(0, MAX_TITLE)
  if (trimmed && (category.custom || trimmed !== category.defaultTitle)) {
    return { ...layout, titles: { ...layout.titles, [category.id]: trimmed } }
  }
  if (category.custom) return layout
  return { ...layout, titles: without(layout.titles, category.id) }
}

// Adds a category the org made. It goes before More.
export function layoutWithCategoryAdded(layout: AppLayout, id: string, title: string): AppLayout {
  const categories = [...layout.categories]
  if (categories.length > 0) {
    const more = categories.indexOf(MORE_CATEGORY)
    if (more >= 0) categories.splice(more, 0, id)
    else categories.push(id)
  }
  return {
    ...layout,
    categories,
    custom: [...layout.custom, id],
    titles: { ...layout.titles, [id]: title.trim().slice(0, MAX_TITLE) || 'Untitled' }
  }
}

// Removes a category the org made. Its apps go back to their own categories.
export function layoutWithoutCategory(layout: AppLayout, id: string): AppLayout {
  return {
    categories: layout.categories.filter(c => c !== id),
    titles: without(layout.titles, id),
    custom: layout.custom.filter(c => c !== id),
    apps: without(layout.apps, id)
  }
}

function without<V>(record: Record<string, V>, key: string): Record<string, V> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key))
}
