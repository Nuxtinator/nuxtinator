// App registry. Each app layer ships a Nitro plugin that calls
// `registerApp({...})` at boot. The launcher (`AppSwitcher.vue`) reads
// `getRegisteredApps()` (filtered by the current user's permissions via
// `/api/_apps`) and renders one tile per app.
//
// Adding an app to `extends:` is the only host edit required. The host
// has no hardcoded list of apps.
//
// ## Deferred: `runtimeConfig.hiddenApps`
//
// A future `runtimeConfig.hiddenApps: ['tasks']` extension point lets a
// deployment suppress an installed app without uninstalling it (drop it
// from the launcher and admin nav while keeping its routes / API / DB
// intact). The filter would apply inside `getRegisteredApps()` (and
// mirror through to `/api/_apps`). Not implemented in V3 — this comment
// is the design hook.

export interface AppEntry {
  id: string
  title: string
  path: string
  icon?: string
  description?: string
  // App-launcher visibility gate. Convention: every app declares an
  // `<id>.access` permission. Apps that omit `requiredPermission` show
  // for everyone.
  requiredPermission?: string
  order?: number
  // Effective status when the host admin hasn't set one (`apps.status` is
  // NULL). Omitted = 'disabled': a newly installed app stays off until the
  // host admin enables it.
  //   'default'   — enabled: single mode shows it; every org has it on
  //   'available' — multi mode: each org admin can turn it on
  //   'host_controlled' — multi mode: only a host admin turns it on per org;
  //                 single mode treats it as 'disabled'
  //   'disabled'  — off everywhere
  defaultStatus?: 'available' | 'default' | 'disabled' | 'host_controlled'
}

const _apps = new Map<string, AppEntry>()

export function registerApp(entry: AppEntry): void {
  if (!entry || typeof entry.id !== 'string' || entry.id.length === 0) return
  _apps.set(entry.id, entry)
}

export function getRegisteredApps(): AppEntry[] {
  return [..._apps.values()].sort((a, b) => {
    const ao = a.order ?? 100
    const bo = b.order ?? 100
    if (ao !== bo) return ao - bo
    return a.title.localeCompare(b.title)
  })
}

export function getRegisteredApp(id: string): AppEntry | null {
  return _apps.get(id) ?? null
}

export function __resetAppRegistryForTests(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('__resetAppRegistryForTests is not callable in production')
  }
  _apps.clear()
}
