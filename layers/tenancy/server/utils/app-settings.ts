// Per-org apps view. Composes on top of core's catalog reader
// (`getApps`) by passing it as `loadDefaults` to a second
// `defineSettings`. See CLAUDE.md → "Settings pattern" for the shape.
//
// Three-tier resolution per app:
//
//   1. Registry default       — layer's `registerApp({ defaultStatus })`
//   2. Host-admin override    — `apps.status` (set via /admin/apps)
//                               'default' = on for orgs without a row,
//                               'available' = off until the org enables it,
//                               'host_controlled' = off until a host admin
//                               enables it; org admins can't change it
//   3. Per-org override       — `org_apps.enabled` (set via /@<org>/settings/apps,
//                               or by a host admin via /admin/apps)
//
// `getApps` resolves (1) and (2). `getOrgApps` adds (3), then turns on the
// apps an enabled app requires (`registerApp({ requires })`) — derived on
// read, never stored. The downstream helpers (`getOrgEnabledApps`,
// `isAppEnabledForOrg`) filter off its result.

import { defineSettings, type DbClient } from '#core/server/utils/settings'
import { getApps, type AppCatalogEntry } from '#core/server/utils/app-settings'
import type { AppStatus } from '#core/server/database/schema'
import type { OrgAppSource } from '../database/schema'

export interface OrgAppEntry extends AppCatalogEntry {
  enabled: boolean
  // Who flipped the org-level switch: 'org_admin' / 'host' / 'auto', or
  // null when no explicit row exists and the answer derives from the
  // catalog status alone.
  source: OrgAppSource | null
  // Org admin can't change it: the host has disabled the app catalog-wide
  // or made it host-controlled.
  lockedByHost: boolean
  // Catalog-level status surfaced for UI tooltips ("Default: available").
  globalStatus: AppStatus
  // Enabled apps that require this one: while any is on, so is this one,
  // and the org can't turn it off.
  requiredBy: string[]
}

interface OrgAppRow {
  app_id: string
  enabled: boolean
  source: OrgAppSource
}

const readOrgApps = defineSettings<AppCatalogEntry, OrgAppRow, Omit<OrgAppEntry, 'requiredBy'>>({
  // Defaults = the catalog merge, filtered to installed apps only. An
  // uninstalled orphan row can't be org-enabled, so it's not even worth
  // surfacing to org-level callers. Personal apps are turned on per user,
  // never per org (see core's personal-apps.ts), so they're left out too.
  loadDefaults: async (tx) => {
    const catalog = await getApps(tx)
    return catalog.filter(a => a.installed && a.scope !== 'user')
  },
  loadOverrides: async (tx, ctx) => {
    if (!ctx.orgId) throw new Error('getOrgApps requires ctx.orgId')
    const rows = await tx
      .selectFrom('org_apps')
      .select(['app_id', 'enabled', 'source'])
      .where('org_id', '=', ctx.orgId)
      .execute()
    return new Map(rows.map(r => [r.app_id, r as OrgAppRow]))
  },
  keyOf: app => app.id,
  merge: (app, orgRow) => {
    const a = app!
    const lockedByHost = a.status === 'disabled' || a.status === 'host_controlled'
    const enabled = resolveOrgAppEnabled(a.status, orgRow)
    return {
      ...a,
      globalStatus: a.status,
      enabled,
      source: orgRow?.source ?? null,
      lockedByHost
    }
  }
})

// The org's apps, with every app an enabled app requires turned on too
// (transitively), unless the host disabled it catalog-wide.
export async function getOrgApps(tx: DbClient, ctx: { orgId: string }): Promise<OrgAppEntry[]> {
  const apps: OrgAppEntry[] = (await readOrgApps(tx, ctx)).map(a => ({ ...a, requiredBy: [] }))
  const byId = new Map(apps.map(a => [a.id, a]))
  let changed = true
  while (changed) {
    changed = false
    for (const app of apps) {
      if (!app.enabled) continue
      for (const id of app.requires) {
        const required = byId.get(id)
        if (!required || required.status === 'disabled' || required.status === 'admins') continue
        if (!required.requiredBy.includes(app.id)) required.requiredBy.push(app.id)
        if (!required.enabled) {
          required.enabled = true
          changed = true
        }
      }
    }
  }
  return apps
}

// Refuses (409) turning off an app that an app still on for the org requires.
export async function assertAppNotRequired(tx: DbClient, orgId: string, appId: string): Promise<void> {
  const apps = await getOrgApps(tx, { orgId })
  const app = apps.find(a => a.id === appId)
  if (!app || app.requiredBy.length === 0) return
  const titles = app.requiredBy.map(id => apps.find(a => a.id === id)?.title ?? id)
  throw createError({ statusCode: 409, statusMessage: `${app.title} is required by ${titles.join(', ')}. Turn ${titles.length === 1 ? 'it' : 'them'} off first.` })
}

// Whether an org has an app on, given the catalog status and the org's row
// (if any). A host-disabled app is off regardless of the row. 'admins' belongs
// to personal apps and reads as disabled for an org app.
export function resolveOrgAppEnabled(status: AppStatus, orgRow: { enabled: boolean } | undefined): boolean {
  if (status === 'disabled' || status === 'admins') return false
  if (orgRow) return orgRow.enabled
  return status === 'default'
}

// Set of installed-and-enabled app IDs for an org. Used by the launcher
// (`/api/.../_apps`), the `app.enabled` gate inside `defineTenantHandler`,
// and any consumer that wants a quick "is X on for this org" check.
export async function getOrgEnabledApps(tx: DbClient, orgId: string): Promise<Set<string>> {
  const apps = await getOrgApps(tx, { orgId })
  return new Set(apps.filter(a => a.enabled).map(a => a.id))
}

export async function isAppEnabledForOrg(
  tx: DbClient,
  orgId: string,
  appId: string
): Promise<boolean> {
  const apps = await getOrgApps(tx, { orgId })
  return apps.some(a => a.id === appId && a.enabled)
}
