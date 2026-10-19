// Rail entries. An app shows in the AppRail as one entry built from its
// `registerApp` record unless it registers rail items via
// `registerRailItem({ appId, id, title, path, ... })`; then the rail shows those
// items instead, so one app can contribute several top-level entries. An item
// shows while its app is on for the org (or user) and the caller holds
// `requiredPermission`. Items and apps share one `order` scale, so a host's
// items and an installed app's entry interleave.

export interface RailItem {
  appId: string
  // Unique within the app.
  id: string
  title: string
  // Single-tenant shape (`/pt/campaigns`) or `/@:orgSlug/...`.
  path: string
  icon?: string
  requiredPermission?: string
  order?: number
}

export interface RailFeedItem {
  id: string
  title: string
  path: string
  icon?: string
  order?: number
}

const _items = new Map<string, RailItem>()

export function registerRailItem(item: RailItem): void {
  if (!item || typeof item.appId !== 'string' || item.appId.length === 0) return
  if (typeof item.id !== 'string' || item.id.length === 0) return
  if (typeof item.path !== 'string' || item.path.length === 0) return
  _items.set(`${item.appId}:${item.id}`, item)
}

export function getRailItems(appId: string): RailItem[] {
  return [..._items.values()]
    .filter(i => i.appId === appId)
    .sort((a, b) => {
      const ao = a.order ?? 100
      const bo = b.order ?? 100
      if (ao !== bo) return ao - bo
      return a.title.localeCompare(b.title)
    })
}

// The app's rail items the caller may see, with `:orgSlug` filled in.
// Undefined when the app registers none, so the rail shows the app itself.
export function railItemsFor(appId: string, perms: ReadonlySet<string>, orgSlug?: string): RailFeedItem[] | undefined {
  const items = getRailItems(appId)
  if (items.length === 0) return undefined
  return items
    .filter(i => !i.requiredPermission || perms.has(i.requiredPermission))
    .map(i => ({
      id: i.id,
      title: i.title,
      path: orgSlug ? i.path.replace(':orgSlug', orgSlug) : i.path,
      icon: i.icon,
      order: i.order
    }))
}

export function __resetRailRegistryForTests(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('__resetRailRegistryForTests is not callable in production')
  }
  _items.clear()
}
