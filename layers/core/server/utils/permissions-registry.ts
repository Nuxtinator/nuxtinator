// Runtime permission registry. The host's static `PERMISSIONS` array stays
// in `app/utils/permissions.ts` as the grep-able source of truth for host
// permissions. App layers self-register their permissions at boot via a
// Nitro plugin calling `registerPermissions(...)`. Consumers ask the
// wrappers below — never the static array directly — so layer
// contributions are always included.
//
// The `Permission` type (open `PermissionRegistry` interface, see
// `~~/app/utils/permissions.ts`) widens at compile time when each layer
// augments it. The runtime registry is the parallel data store: the
// strings the server actually treats as live at request time.

import { PERMISSIONS, PERMISSION_META } from '#core/app/utils/permissions'

export interface PermissionMeta {
  title: string
  description: string
}

const _layerPerms = new Set<string>()
const _layerMeta = new Map<string, PermissionMeta>()
const _withheldFromAdmin = new Set<string>()

export function registerPermissions(
  perms: ReadonlyArray<string>,
  meta?: Record<string, PermissionMeta>
): void {
  for (const p of perms) {
    if (typeof p === 'string' && p.length > 0) _layerPerms.add(p)
  }
  if (meta) {
    for (const [k, v] of Object.entries(meta)) _layerMeta.set(k, v)
  }
}

export function getAllPermissions(): string[] {
  return [...PERMISSIONS, ..._layerPerms]
}

export function isRegisteredPermission(perm: string): boolean {
  if ((PERMISSIONS as readonly string[]).includes(perm)) return true
  return _layerPerms.has(perm)
}

// Permissions the `admin` role does not receive automatically. A host calls
// this to keep a layer's permission from org/site admins; users then hold it
// only through another role or a per-user grant.
export function withholdFromAdmin(perms: ReadonlyArray<string>): void {
  for (const p of perms) {
    if (typeof p === 'string' && p.length > 0) _withheldFromAdmin.add(p)
  }
}

export function isWithheldFromAdmin(perm: string): boolean {
  return _withheldFromAdmin.has(perm)
}

export function getPermissionMeta(perm: string): PermissionMeta | undefined {
  return PERMISSION_META[perm] ?? _layerMeta.get(perm)
}

export function __resetPermissionsRegistryForTests(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('__resetPermissionsRegistryForTests is not callable in production')
  }
  _layerPerms.clear()
  _layerMeta.clear()
  _withheldFromAdmin.clear()
}
