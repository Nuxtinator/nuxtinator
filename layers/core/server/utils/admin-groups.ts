import type { DbClient } from './settings'
import { getGroup } from './groups'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The host group a host-admin route names, or 404. An org's group is not
// reachable through the host routes.
export async function requireHostGroup(tx: DbClient, id: string | undefined) {
  const group = id && UUID_RE.test(id) ? await getGroup(tx, id) : null
  if (!group || group.org_id !== null) throw createError({ statusCode: 404, statusMessage: 'Group not found' })
  return group
}
