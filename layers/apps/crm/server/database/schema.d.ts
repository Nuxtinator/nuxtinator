// Adds the crm (contacts) tables to the host schema by merging into core's
// global `NuxtinatorDatabaseTables` registry (resolution-independent — see
// core's server/database/schema.ts). The record tables they hang off belong
// to the records layer.
import type { ColumnType, Generated } from 'kysely'

// Code-owned-forever vocabularies (mirrored by CHECK constraints in the
// migrations). Open vocabularies — channel_type, purpose, source — stay plain
// strings.
export type ChannelValueFormat = 'email' | 'phone' | 'handle' | 'url' | 'freeform'
export type ConsentStatus = 'opt_in' | 'opt_out'
export type ConsentEvent = 'grant' | 'revoke'
export type SuppressionReason = 'hard_bounce' | 'complaint' | 'manual'

export interface CrmChannelTypesTable {
  id: Generated<string>
  type_key: string
  label: string | null
  value_format: ChannelValueFormat | null
  config: Generated<Record<string, unknown>>
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
}

export interface CrmChannelsTable {
  id: Generated<string>
  channel_type: string
  value: string
  normalized_value: string
  verified: Generated<boolean>
  verified_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>
  verification_token_hash: string | null
  verification_expires_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>
}

export interface CrmContactChannelsTable {
  id: Generated<string>
  record_id: string
  channel_id: string
  field_key: string
  label: string | null
  is_primary: Generated<boolean>
  sort_order: Generated<number>
}

export interface CrmChannelConsentsTable {
  id: Generated<string>
  channel_id: string
  purpose: string
  status: ConsentStatus
  granted_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>
  revoked_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>
  source: string | null
  capture_meta: Generated<Record<string, unknown>>
}

export interface CrmConsentEventsTable {
  id: Generated<string>
  channel_id: string | null
  channel_value: string
  address_fingerprint: string
  purpose: string
  event: ConsentEvent
  source: string | null
  actor_user_id: string | null
  ip: string | null
  user_agent: string | null
  meta: Generated<Record<string, unknown>>
  occurred_at: ColumnType<Date, Date | string | undefined, Date | string>
}

export interface CrmChannelSuppressionsTable {
  id: Generated<string>
  channel_id: string
  reason: SuppressionReason
  detail: string | null
  source: string | null
  created_by: string | null
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
  cleared_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>
}

declare global {
  interface NuxtinatorDatabaseTables {
    crm_channel_types: CrmChannelTypesTable
    crm_channels: CrmChannelsTable
    crm_contact_channels: CrmContactChannelsTable
    crm_channel_consents: CrmChannelConsentsTable
    crm_consent_events: CrmConsentEventsTable
    crm_channel_suppressions: CrmChannelSuppressionsTable
  }
}
