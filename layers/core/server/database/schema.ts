import type { ColumnType, Generated } from 'kysely'

// Resolution-independent schema augmentation.
//
// Optional layers (tenancy, oauth, every app layer) extend the host's schema
// by merging into the global interfaces declared here — never by augmenting
// this module through the `#core` path alias. Global interface merging does not
// go through module resolution, so it merges identically whether a layer is
// resolved via a workspace symlink, an npm tarball, a git URL, or a
// `#core/* → _layers/*` tsconfig `paths` alias in a downstream host.
// Path-aliased `declare module '#core/server/database/schema'` augmentation, by
// contrast, silently fails to merge in `_layers/`-style consumer hosts (the
// path alias is not honored when resolving a `declare module` target there),
// which left every layer table invisible to Kysely.
//
// A layer adds tables:
//   declare global {
//     interface NuxtinatorDatabaseTables { my_table: MyTable }
//   }
// and retrofits extra columns onto a core table:
//   declare global {
//     interface NuxtinatorCustomRolesColumns { org_id: string }
//   }
declare global {
  // Tables contributed by optional layers. Empty here; each layer merges its
  // own tables in. Joined into `Database` below.
  interface NuxtinatorDatabaseTables {}

  // Extra columns optional layers retrofit onto core tables. The tenancy layer
  // adds `org_id` here when loaded; both are empty otherwise.
  interface NuxtinatorCustomRolesColumns {}
  interface NuxtinatorActivityLogsColumns {}
}

export interface UsersTable {
  id: Generated<string>
  created: ColumnType<Date, string | undefined, string>
  updated: ColumnType<Date, string | undefined, string>
  // Null for a user created without an address (see migration 016).
  email: string | null
  display_name: string
  avatar: Generated<string>
  password: ColumnType<string | null, string | null | undefined, string | null>
  verified: Generated<boolean>
  is_admin: Generated<boolean>
  roles: Generated<string[]>
  token_key: Generated<string>
  token_expires_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>
  pending_email: string | null
  email_change_token: string | null
}

export interface PasswordResetRequestsTable {
  id: Generated<string>
  created: ColumnType<Date, Date | string | undefined, Date | string>
  expires: ColumnType<Date, Date | string, Date | string>
  user_id: string
  token: string
  used: Generated<boolean>
}

export interface ActivityLogsTable extends NuxtinatorActivityLogsColumns {
  id: Generated<string>
  timestamp: ColumnType<Date, Date | string | undefined, Date | string>
  event_type: string
  table_name: string | null
  record_id: string | null
  user_id: string | null
  user_agent: string | null
  metadata: Generated<Record<string, unknown>>
}

export interface CustomRolesTable extends NuxtinatorCustomRolesColumns {
  id: Generated<string>
  created: ColumnType<Date, string | undefined, string>
  updated: ColumnType<Date, string | undefined, string>
  name: string
  description: Generated<string>
  permissions: Generated<string[]>
}

export type AppStatus = 'disabled' | 'available' | 'default' | 'host_controlled'

export interface AppsTable {
  id: string
  status: AppStatus | null
  created_at: ColumnType<Date, string | undefined, string>
  updated_at: ColumnType<Date, string | undefined, string>
}

// Shared key-value settings store. One row per (namespace, key) holding a
// human-chosen OVERRIDE value as jsonb. Defaults and labels never live here —
// each layer declares them in code via `registerSetting()`; reads merge the
// registry default with the row when present (see settings-store.ts). The
// `namespace` is the owning layer's app id (e.g. 'feedback'), so keys can't
// collide across layers.
//
// In multi-tenant mode the tenancy layer retrofits an `org_id` column + RLS
// (tenancy_013_retrofit_core_settings), scoping every row to one org; in
// single-tenant mode there is no org_id and the store is deployment-global.
// `org_id` is intentionally absent from this type — RLS and the column default
// keep it invisible to queries, the same way app-layer tenant tables omit it.
export interface CoreSettingsTable {
  id: Generated<string>
  namespace: string
  key: string
  // jsonb. Reads return the parsed JS value (object | array | scalar). All
  // writes go through `setSetting`, which serializes with an explicit ::jsonb
  // cast — never assign a raw JS value to this column directly.
  value: ColumnType<unknown, unknown, unknown>
  updated_at: ColumnType<Date, string | undefined, string>
}

// Deployment-global settings store. Same row shape and merge rule as
// `core_settings`, but the tenancy layer never retrofits this table, so one
// row is one value for the whole deployment in either mode. Read and written
// only through `getHostSetting` / `setHostSetting` (settings-store.ts).
export interface CoreHostSettingsTable {
  id: Generated<string>
  namespace: string
  key: string
  value: ColumnType<unknown, unknown, unknown>
  updated_at: ColumnType<Date, string | undefined, string>
}

// Per-user additive permission grants — effective perms = role perms ∪ these
// rows (see rbac + the tenant kernels). `permission` is a slug; the runtime
// permissions registry decides whether a stored slug still grants anything.
//
// In multi-tenant mode the tenancy layer's `tenancy_014` retrofit adds
// `org_id` + RLS, scoping every grant to one org; in single-tenant mode there
// is no org_id and a grant is user-global. `org_id` is intentionally absent
// from this type — RLS and the column default keep it invisible to queries,
// the same way `core_settings` and app-layer tenant tables omit it.
export interface UserPermissionGrantsTable {
  id: Generated<string>
  user_id: string
  permission: string
  granted_by: string | null
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
}

export type SessionClient = 'web' | 'native'

// One signed-in device. See migration 011_create_sessions.
export interface SessionsTable {
  id: Generated<string>
  user_id: string
  client: SessionClient
  refresh_token_hash: string
  previous_refresh_token_hash: string | null
  rotated_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
  last_used_at: ColumnType<Date, Date | string | undefined, Date | string>
  expires_at: ColumnType<Date, Date | string, Date | string>
  authenticated_at: ColumnType<Date, Date | string | undefined, Date | string>
  user_agent: string | null
  ip: string | null
}

// A pending invitation; `email` is NULL for shareable link invites. See
// migration 012_create_invites.
export interface InvitesTable {
  id: Generated<string>
  token_hash: string
  email: string | null
  display_name: string | null
  invited_by: string | null
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
  expires_at: ColumnType<Date, Date | string, Date | string>
  accepted_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>
  accepted_by: string | null
}

// A host admin's grant of a personal app to one user. See migration
// 015_create_user_apps.
export interface UserAppsTable {
  id: Generated<string>
  user_id: string
  app_id: string
  granted_by: string | null
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
}

// A personal app an invite grants once accepted.
export interface InviteAppsTable {
  invite_id: string
  app_id: string
}

export type NotificationEmailMode = 'immediate' | 'digest' | 'none'

export interface NotificationsTable {
  id: Generated<string>
  user_id: string
  app_id: string
  title: string
  body: string | null
  icon: string | null
  link: string
  actor_id: string | null
  email_mode: Generated<NotificationEmailMode>
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
  read_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>
  emailed_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>
}

// The always-on core tables. Optional-layer tables live in the global
// `NuxtinatorDatabaseTables` registry and are joined in by `Database` below.
export interface CoreDatabase {
  users: UsersTable
  password_reset_requests: PasswordResetRequestsTable
  activity_logs: ActivityLogsTable
  custom_roles: CustomRolesTable
  apps: AppsTable
  notifications: NotificationsTable
  core_settings: CoreSettingsTable
  core_host_settings: CoreHostSettingsTable
  user_permission_grants: UserPermissionGrantsTable
  sessions: SessionsTable
  invites: InvitesTable
  user_apps: UserAppsTable
  invite_apps: InviteAppsTable
}

// The full schema Kysely sees: core tables plus whatever optional layers
// registered. The `& NuxtinatorDatabaseTables` join is resolution-independent —
// see the note at the top of this file.
export type Database = CoreDatabase & NuxtinatorDatabaseTables
