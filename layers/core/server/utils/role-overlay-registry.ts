// Lets a layer adjust what each role grants inside one org before
// `getRolePermissions` (server/utils/rbac.ts) unions the roles together. The
// tenancy layer registers one to apply its per-org role overrides. A single
// overlay is held; registering again replaces it.

export type RoleOverlay = (orgId: string, perRole: Map<string, Set<string>>) => Promise<void>

let overlay: RoleOverlay | null = null

export function registerRoleOverlay(fn: RoleOverlay): void {
  overlay = fn
}

export function getRoleOverlay(): RoleOverlay | null {
  return overlay
}
