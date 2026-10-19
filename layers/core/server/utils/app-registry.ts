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
  // For a personal app (`scope: 'user'`), 'default' is on for every signed-in
  // user, and 'available' / 'host_controlled' are on only for users a host
  // admin granted it to.
  defaultStatus?: 'available' | 'default' | 'disabled' | 'host_controlled'
  // 'org' (default): the app's data belongs to an org and it is turned on per
  // org. 'user': a personal app — its data belongs to each user, it is the
  // same in every org, and it is turned on per user (see personal-apps.ts).
  // A personal layer also maps its id to its path under
  // `runtimeConfig.public.personalApps` so routing can tell its pages apart
  // at build time.
  scope?: 'org' | 'user'
  // Personal apps only: the permissions a user holds while the app is on for
  // them. Personal apps take no permissions from roles.
  permissions?: string[]
}

// How a host presents an installed app, set with `configureApp` from a host
// Nitro plugin without editing the app's layer. `defaultStatus` replaces the
// layer's registry default (still below a host admin's `apps.status`).
export interface AppPresentation {
  title?: string
  icon?: string
  order?: number
  defaultStatus?: AppEntry['defaultStatus']
}

const _apps = new Map<string, AppEntry>()
const _presentation = new Map<string, AppPresentation>()

export function registerApp(entry: AppEntry): void {
  if (!entry || typeof entry.id !== 'string' || entry.id.length === 0) return
  _apps.set(entry.id, entry)
}

// Applied whenever the registry is read, so it works whether the host's plugin
// runs before or after the layer's `registerApp`.
export function configureApp(id: string, presentation: AppPresentation): void {
  if (typeof id !== 'string' || id.length === 0) return
  const defined = Object.fromEntries(Object.entries(presentation).filter(([, v]) => v !== undefined))
  _presentation.set(id, { ..._presentation.get(id), ...defined })
}

function presented(entry: AppEntry): AppEntry {
  const p = _presentation.get(entry.id)
  return p ? { ...entry, ...p } : entry
}

export function getRegisteredApps(): AppEntry[] {
  return [..._apps.values()].map(presented).sort((a, b) => {
    const ao = a.order ?? 100
    const bo = b.order ?? 100
    if (ao !== bo) return ao - bo
    return a.title.localeCompare(b.title)
  })
}

export function getRegisteredApp(id: string): AppEntry | null {
  const entry = _apps.get(id)
  return entry ? presented(entry) : null
}

// Permissions owned by personal apps. Roles never grant these: a user holds
// them only while the app is on for them (see personal-apps.ts).
export function getPersonalAppPermissionSlugs(): Set<string> {
  const out = new Set<string>()
  for (const app of _apps.values()) {
    if (app.scope === 'user') for (const p of app.permissions ?? []) out.add(p)
  }
  return out
}

export function __resetAppRegistryForTests(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('__resetAppRegistryForTests is not callable in production')
  }
  _apps.clear()
  _presentation.clear()
}
