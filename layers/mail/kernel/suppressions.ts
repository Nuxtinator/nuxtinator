// The kernel's suppression list. Rows hold only address hashes. A hard
// bounce is `global` (host account) or `org` (org-owned account); a
// complaint is `org` or `host`, scoped to whoever sent the mail. Which rows
// apply to a send: global ones, the sending org's, and host ones for host mail.
import { sql, type Kysely, type Transaction } from 'kysely'
import { addressHash } from './address'
import type { MailDatabase, MailSuppressionRow, SuppressionReason, SuppressionScope } from './schema'
import type { SuppressionHit } from './types'

type Db = Kysely<MailDatabase> | Transaction<MailDatabase>

function applicable(orgId: string | null) {
  return sql<boolean>`(scope = 'global' OR (scope = 'org' AND org_id = ${orgId}::uuid) OR (scope = 'host' AND ${orgId}::uuid IS NULL))`
}

export async function activeSuppressions(db: Db, hashes: string[], orgId: string | null): Promise<MailSuppressionRow[]> {
  if (hashes.length === 0) return []
  return await db
    .selectFrom('mail_suppressions')
    .selectAll()
    .where('address_hash', 'in', hashes)
    .where('cleared_at', 'is', null)
    .where(applicable(orgId))
    .execute()
}

// A complaint is reported ahead of a hard bounce when both apply.
export async function isSuppressed(db: Db, address: string, orgId: string | null): Promise<false | SuppressionHit> {
  const rows = await activeSuppressions(db, [addressHash(address)], orgId)
  if (rows.length === 0) return false
  const row = rows.find(r => r.reason === 'complaint') ?? rows[0]!
  return { reason: row.reason, scope: row.scope }
}

export async function suppressedAmong(db: Db, addresses: string[], orgId: string | null): Promise<Set<string>> {
  const byHash = new Map<string, string[]>()
  for (const a of addresses) {
    const h = addressHash(a)
    byHash.set(h, [...(byHash.get(h) ?? []), a])
  }
  const rows = await activeSuppressions(db, [...byHash.keys()], orgId)
  const out = new Set<string>()
  for (const row of rows) for (const a of byHash.get(row.address_hash) ?? []) out.add(a)
  return out
}

export interface RecordSuppressionInput {
  address: string
  scope: SuppressionScope
  orgId: string | null
  reason: SuppressionReason
  detail?: string | null
  source?: string | null
  accountId?: string | null
  occurredAt: Date
}

// Inserts an active row unless one exists for the same address, scope, org
// and reason. Returns true when a row was written.
export async function recordSuppression(db: Db, input: RecordSuppressionInput): Promise<boolean> {
  const res = await db
    .insertInto('mail_suppressions')
    .values({
      address_hash: addressHash(input.address),
      org_id: input.scope === 'org' ? input.orgId : null,
      scope: input.scope,
      reason: input.reason,
      detail: input.detail ?? null,
      source: input.source ?? null,
      account_id: input.accountId ?? null,
      occurred_at: input.occurredAt
    })
    .onConflict(oc => oc.doNothing())
    .executeTakeFirst()
  return Number(res.numInsertedOrUpdatedRows ?? 0) > 0
}

// Clears active hard bounces that are older than `before`, in the given
// scopes. Returns the cleared rows.
export async function clearHardBounces(
  db: Db,
  address: string,
  scope: { kind: 'global' } | { kind: 'org', orgId: string },
  before: Date
): Promise<MailSuppressionRow[]> {
  let q = db
    .updateTable('mail_suppressions')
    .set({ cleared_at: sql`now()`, cleared_reason: 'delivered' })
    .where('address_hash', '=', addressHash(address))
    .where('reason', '=', 'hard_bounce')
    .where('cleared_at', 'is', null)
    .where('occurred_at', '<', before)
  q = scope.kind === 'global'
    ? q.where('scope', '=', 'global')
    : q.where('scope', '=', 'org').where('org_id', '=', scope.orgId)
  return await q.returningAll().execute()
}

export async function anySuppressionRows(db: Db, address: string, reason: SuppressionReason): Promise<MailSuppressionRow[]> {
  return await db
    .selectFrom('mail_suppressions')
    .selectAll()
    .where('address_hash', '=', addressHash(address))
    .where('reason', '=', reason)
    .execute()
}
