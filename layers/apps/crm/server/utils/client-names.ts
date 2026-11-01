// Display names of the OAuth clients timeline rows came through ("via
// Claude"). The oauth layer that owns `oauth_clients` is optional, so the
// lookup is skipped when the table doesn't exist; an unknown client shows its
// id.

import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'

type Tx = Transaction<Database>

export async function resolveClientNames(tx: Tx, clientIds: Array<string | null>): Promise<Map<string, string>> {
  const ids = [...new Set(clientIds.filter((id): id is string => !!id))]
  const names = new Map<string, string>(ids.map(id => [id, id]))
  if (ids.length === 0) return names
  const { rows: [exists] } = await sql<{ present: boolean }>`
    select to_regclass('oauth_clients') is not null as present
  `.execute(tx)
  if (!exists?.present) return names
  const { rows } = await sql<{ client_id: string, client_name: string | null }>`
    select client_id, client_name from oauth_clients where client_id in (${sql.join(ids)})
  `.execute(tx)
  for (const r of rows) {
    const name = r.client_name?.trim()
    if (name) names.set(r.client_id, name)
  }
  return names
}
