import crypto from 'node:crypto'
import { sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely'
import type { ParsedAddress } from './types'

// Must equal `encode(sha256(convert_to(lower(btrim(addr)), 'UTF8')), 'hex')`
// byte for byte. btrim trims spaces only, so this does too.
export function addressHash(address: string): string {
  const normalized = address.replace(/^ +| +$/g, '').toLowerCase()
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex')
}

export function parseAddress(address: string): ParsedAddress | null {
  const bare = (address.match(/<([^>]+)>/)?.[1] ?? address).trim().toLowerCase()
  const at = bare.lastIndexOf('@')
  if (at <= 0 || at === bare.length - 1) return null
  return { address: bare, local: bare.slice(0, at), domain: bare.slice(at + 1) }
}

export function domainOf(address: string): string | null {
  return parseAddress(address)?.domain ?? null
}

// The same rule as the SQL function `mail_is_suppressed`, as a NOT EXISTS for
// typed queries: `.where(eb => notSuppressed(eb, 'c.email', 'c.org_id'))`.
export function notSuppressed(
  _eb: ExpressionBuilder<any, any>,
  addressRef: string | Expression<string>,
  orgIdRef: string | Expression<string | null> | null
): Expression<SqlBool> {
  const addr = typeof addressRef === 'string' ? sql.ref(addressRef) : addressRef
  const org = orgIdRef === null ? sql`null::uuid` : typeof orgIdRef === 'string' ? sql.ref(orgIdRef) : orgIdRef
  return sql<SqlBool>`NOT EXISTS (
    SELECT 1 FROM mail_suppressions s
    WHERE s.cleared_at IS NULL
      AND s.address_hash = encode(sha256(convert_to(lower(btrim(${addr}::text)), 'UTF8')), 'hex')
      AND (s.scope = 'global'
        OR (s.scope = 'org' AND s.org_id = ${org}::uuid)
        OR (s.scope = 'host' AND ${org}::uuid IS NULL))
  )`
}
