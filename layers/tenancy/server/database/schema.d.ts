// Tenancy layer schema augmentation. Adds the org/membership/app-enable tables
// and retrofits `org_id` onto two core tables, by merging into core's global
// schema registries (`NuxtinatorDatabaseTables` for tables, the per-table
// `Nuxtinator*Columns` registries for columns). Global interface merging is
// resolution-independent, so it merges the same way whether `#core` resolves
// via a workspace symlink, an npm package, or a `_layers/` path alias in a
// downstream host. Pulled into the host's compile when the tenancy layer is in
// `extends:`.
import type { ColumnType, Generated } from 'kysely'

export interface OrgsTable {
  id: Generated<string>
  slug: string
  name: string
  suspended_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>
  created_at: ColumnType<Date, string | undefined, string>
  updated_at: ColumnType<Date, string | undefined, string>
}

export interface MembershipsTable {
  id: Generated<string>
  user_id: string
  org_id: string
  roles: Generated<string[]>
  created_at: ColumnType<Date, string | undefined, string>
  updated_at: ColumnType<Date, string | undefined, string>
}

export type OrgAppSource = 'auto' | 'org_admin' | 'host'

export interface OrgAppsTable {
  org_id: string
  app_id: string
  enabled: boolean
  source: OrgAppSource
  updated_at: ColumnType<Date, string | undefined, string>
}

export type OrgRoleOverrideEffect = 'grant' | 'revoke'

export interface OrgRoleOverridesTable {
  org_id: string
  role_name: string
  permission: string
  effect: OrgRoleOverrideEffect
  created_at: ColumnType<Date, string | undefined, string>
  updated_at: ColumnType<Date, string | undefined, string>
}

// The orgs an invite grants on acceptance, with the roles in each.
export interface InviteOrgsTable {
  invite_id: string
  org_id: string
  roles: Generated<string[]>
}

declare global {
  interface NuxtinatorDatabaseTables {
    orgs: OrgsTable
    invite_orgs: InviteOrgsTable
    memberships: MembershipsTable
    org_apps: OrgAppsTable
    org_role_overrides: OrgRoleOverridesTable
  }

  // The tenancy layer also retrofits `org_id` onto two existing core tables;
  // declare the columns here so TS knows about them inside the layer's code.
  interface NuxtinatorCustomRolesColumns {
    org_id: string
  }

  interface NuxtinatorActivityLogsColumns {
    org_id: string | null
  }
}
