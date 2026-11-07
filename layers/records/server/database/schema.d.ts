// Adds the records kernel tables to the host schema by merging into core's
// global `NuxtinatorDatabaseTables` registry (resolution-independent — see
// core's server/database/schema.ts).
import type { ColumnType, Generated } from 'kysely'

// Code-owned-forever vocabularies (mirrored by CHECK constraints in the
// migrations). Open vocabularies — record_type, status, field_key — stay
// plain strings.
export type RecordsShareLevel = 'view' | 'edit'

export interface RecordsEntriesTable {
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

export interface RecordFieldEntriesTable {
  id: Generated<string>
  record_id: string
  field_key: string
  payload: Generated<Record<string, unknown>>
  normalized_value: string | null
  sort_order: Generated<number>
}

export interface RecordUserRefsTable {
  record_id: string
  field_key: string
  user_id: string
  created_by: string | null
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
}

export interface RecordConnectionsTable {
  id: Generated<string>
  from_record_id: string
  to_record_id: string
  field_key: string
  meta: Generated<Record<string, unknown>>
}

export interface RecordSharesTable {
  record_id: string
  user_id: string
  // 'view' grants visibility only; 'edit' additionally grants record-scoped
  // update capability (see server/utils/type-permissions.ts).
  level: Generated<RecordsShareLevel>
  granted_by: string | null
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
}

export interface RecordActivityTable {
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
  // The OAuth client the change came through; null for browser requests.
  client_id: ColumnType<string | null, string | null | undefined, string | null>
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
}

export interface RecordCommentsTable {
  id: Generated<string>
  record_id: string
  author_id: string | null
  author_label: string | null
  body: string
  // The OAuth client the comment came through; null for browser requests.
  client_id: ColumnType<string | null, string | null | undefined, string | null>
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>
  edited_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>
}

export interface RecordTypesTable {
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

export interface RecordFieldsTable {
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
    records_entries: RecordsEntriesTable
    records_field_entries: RecordFieldEntriesTable
    records_user_refs: RecordUserRefsTable
    records_connections: RecordConnectionsTable
    records_shares: RecordSharesTable
    records_activity: RecordActivityTable
    records_comments: RecordCommentsTable
    records_types: RecordTypesTable
    records_fields: RecordFieldsTable
  }
}
