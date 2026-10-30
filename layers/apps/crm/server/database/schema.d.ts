// Adds the crm tables to the host schema by merging into core's global
// `NuxtinatorDatabaseTables` registry (resolution-independent — see core's
// server/database/schema.ts).
import type { ColumnType, Generated } from 'kysely'

// Code-owned-forever vocabularies (mirrored by CHECK constraints in the
// migrations). Open vocabularies — record_type, status, channel_type,
// field_key, purpose, source — stay plain strings.
export type ChannelValueFormat = 'email' | 'phone' | 'handle' | 'url' | 'freeform'
export type ConsentStatus = 'opt_in' | 'opt_out'
export type ConsentEvent = 'grant' | 'revoke'
export type SuppressionReason = 'hard_bounce' | 'complaint' | 'manual'
export type CrmShareLevel = 'view' | 'edit'

export interface CrmRecordsTable {
  id: Generated<string>
  record_type: string
  name: string
  status: string | null
  // Deliberately loose: which keys exist in `data` is manifest-driven; typed
  // access goes through the kernel's per-type inference, not this interface.
  data: Generated<Record<string, unknown>>
  created_by: string
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>
  // The user account of the person the record describes (see crm_011).
  user_id: ColumnType<string | null, string | null | undefined, string | null>
}

export interface CrmRecordFieldEntriesTable {
  id: Generated<string>
  record_id: string
  field_key: string
  payload: Generated<Record<string, unknown>>
  normalized_value: string | null
  sort_order: Generated<number>
}

export interface CrmRecordUserRefsTable {
  record_id: string
  field_key: string
  user_id: string
  created_by: string | null
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
}

export interface CrmRecordConnectionsTable {
  id: Generated<string>
  from_record_id: string
  to_record_id: string
  field_key: string
  meta: Generated<Record<string, unknown>>
}

export interface CrmRecordSharesTable {
  record_id: string
  user_id: string
  // 'view' grants visibility only; 'edit' additionally grants record-scoped
  // update capability (see server/utils/type-permissions.ts).
  level: Generated<CrmShareLevel>
  granted_by: string | null
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
}

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

export interface CrmRecordActivityTable {
  id: Generated<string>
  record_id: string
  actor_user_id: string | null
  actor_label: string | null
  action: string
  field_key: string | null
  // Full jsonb snapshots of a field's value; shape depends on the field kind.
  old_value: unknown
  new_value: unknown
  note: string | null
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
}

export interface CrmRecordCommentsTable {
  id: Generated<string>
  record_id: string
  author_id: string | null
  author_label: string | null
  body: string
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>
  edited_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>
}

export interface CrmRecordTypesTable {
  id: Generated<string>
  type_key: string
  label_override: string | null
  label_singular_override: string | null
  icon_override: string | null
  hidden: Generated<boolean>
  config: Generated<Record<string, unknown>>
  is_custom: Generated<boolean>
  updated_by: string | null
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>
}

export interface CrmRecordFieldsTable {
  id: Generated<string>
  type_key: string
  field_key: string
  kind: string | null
  label_override: string | null
  hidden: Generated<boolean>
  required_override: boolean | null
  order_override: number | null
  section_override: string | null
  icon_override: string | null
  config: Generated<Record<string, unknown>>
  updated_by: string | null
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>
}

declare global {
  interface NuxtinatorDatabaseTables {
    crm_records: CrmRecordsTable
    crm_record_field_entries: CrmRecordFieldEntriesTable
    crm_record_user_refs: CrmRecordUserRefsTable
    crm_record_connections: CrmRecordConnectionsTable
    crm_record_shares: CrmRecordSharesTable
    crm_channel_types: CrmChannelTypesTable
    crm_channels: CrmChannelsTable
    crm_contact_channels: CrmContactChannelsTable
    crm_channel_consents: CrmChannelConsentsTable
    crm_consent_events: CrmConsentEventsTable
    crm_channel_suppressions: CrmChannelSuppressionsTable
    crm_record_activity: CrmRecordActivityTable
    crm_record_comments: CrmRecordCommentsTable
    crm_record_types: CrmRecordTypesTable
    crm_record_fields: CrmRecordFieldsTable
  }
}
