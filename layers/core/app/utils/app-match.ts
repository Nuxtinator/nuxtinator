// `path` without a leading `/@<slug>` or `/@:orgSlug` segment, so tenant routes
// and both registered path shapes (`/crm`, `/@:orgSlug/crm`) compare alike.
export function stripOrgPrefix(path: string): string {
  const m = path.match(/^\/@[^/]+(\/.*)?$/)
  return m ? (m[1] ?? '/') : path
}

// The app whose path is the longest prefix of `routePath`, ignoring org prefixes.
export function matchAppByPath<T extends { path: string }>(apps: T[], routePath: string): T | null {
  const path = stripOrgPrefix(routePath)
  let best: T | null = null
  let bestLen = -1
  for (const app of apps) {
    const appPath = stripOrgPrefix(app.path)
    if ((path === appPath || path.startsWith(appPath + '/')) && appPath.length > bestLen) {
      best = app
      bestLen = appPath.length
    }
  }
  return best
}
