// Test stub for #core/server/utils/permissions-registry. No layer registers
// runtime permissions in the unit suite, so only the static stub catalog counts.
import { PERMISSIONS } from '../../app/utils/permissions'

export function isRegisteredPermission(perm: string): boolean {
  return (PERMISSIONS as readonly string[]).includes(perm)
}
