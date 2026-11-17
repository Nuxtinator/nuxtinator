// Kysely table types for the mail tables (created by core's migrations
// 023–025). The kernel types its own queries against these; hosts merge them
// into their Database interface.
import type { ColumnType, Generated, Selectable } from 'kysely'

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>
type Json<T> = ColumnType<T, T | string | undefined, T | string>

export type CapabilityKey = 'send' | 'domains' | 'routes' | 'webhooks' | 'suppressionLists'
export type Capabilities = Partial<Record<CapabilityKey, boolean>>

export interface MailAccountsTable {
  id: Generated<string>
  org_id: string | null
  source: Generated<'ui' | 'env'>
  provider: string | null
  label: string | null
  credentials: string | null
  capabilities: Json<Capabilities>
  env_fingerprint: string | null
  webhook_token_version: Generated<number>
  created_by: string | null
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export type DomainRoleStatus = 'pending' | 'verified' | 'failed'
export type OwnershipStatus = 'verified' | 'pending' | 'lapsed'

export interface DnsRecord {
  role: 'send' | 'receive' | 'ownership'
  type: 'TXT' | 'CNAME' | 'MX'
  name: string
  value: string
  priority?: number
  status?: 'pending' | 'verified' | 'failed'
  purpose?: string
}

export interface MailDomainsTable {
  id: Generated<string>
  org_id: string | null
  source: Generated<'ui' | 'env'>
  domain: string
  ownership_status: OwnershipStatus
  ownership_token: string | null
  ownership_failures: Generated<number>
  from_domain: string | null
  send_account_id: string | null
  receive_account_id: string | null
  setup_mode: Generated<'auto' | 'manual'>
  credentials: string | null
  capabilities: Json<Capabilities | null> | null
  dkim_selector: string | null
  probe_token: string | null
  send_status: Generated<DomainRoleStatus>
  receive_status: Generated<DomainRoleStatus>
  send_error: string | null
  dns_records: Json<DnsRecord[]>
  provider_refs: Json<Record<string, unknown>>
  webhook_events: Json<string[] | null> | null
  last_checked_at: NullableTimestamp
  verified_at: NullableTimestamp
  created_at: Generated<Date>
}

export interface MailStreamRoutesTable {
  id: Generated<string>
  org_id: string | null
  stream: string
  domain_id: string
}

export type SuppressionScope = 'global' | 'host' | 'org'
export type SuppressionReason = 'hard_bounce' | 'complaint'

export interface MailSuppressionsTable {
  id: Generated<string>
  address_hash: string
  org_id: string | null
  scope: SuppressionScope
  reason: SuppressionReason
  detail: string | null
  source: string | null
  account_id: string | null
  occurred_at: Timestamp
  created_at: Generated<Date>
  cleared_at: NullableTimestamp
  cleared_reason: 'delivered' | 'admin' | null
}

export type OutboxStatus = 'queued' | 'sending' | 'sent' | 'failed'

export interface MailOutboxTable {
  id: Generated<string>
  org_id: string | null
  stream: string
  message: string | null
  status: Generated<OutboxStatus>
  attempts: Generated<number>
  next_attempt_at: NullableTimestamp
  claimed_by: string | null
  claimed_until: NullableTimestamp
  attempt_started_at: NullableTimestamp
  last_error: string | null
  provider_message_id: string | null
  expires_at: Timestamp
  created_at: Generated<Date>
  sent_at: NullableTimestamp
}

export interface MailDatabase {
  mail_accounts: MailAccountsTable
  mail_domains: MailDomainsTable
  mail_stream_routes: MailStreamRoutesTable
  mail_suppressions: MailSuppressionsTable
  mail_outbox: MailOutboxTable
}

export type MailAccountRow = Selectable<MailAccountsTable>
export type MailDomainRow = Selectable<MailDomainsTable>
export type MailStreamRouteRow = Selectable<MailStreamRoutesTable>
export type MailSuppressionRow = Selectable<MailSuppressionsTable>
export type MailOutboxRow = Selectable<MailOutboxTable>
