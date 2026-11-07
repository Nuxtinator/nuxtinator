// View assembly for the role-grants admin surface (the roles × actions
// matrix in /crm/settings/permissions). Read-only over core's role
// machinery — the matrix needs the org's assignable role list and each
// role's *own* slug answers, so per-role sets come from getRolePermissions
// for that single role, mirroring the evaluator's fallback logic in
// type-permissions.ts (ctx.perms is the caller's pre-unioned set and cannot
// answer per-role questions).

import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { TenantContext } from '#tenant/server'
import { getAllStaticRoles } from '#core/server/utils/roles-registry'
import { getRolePermissions } from '#core/server/utils/rbac'
import { listGroups } from '#core/server/utils/groups'
import type { RecordTypeSetting } from './definition-settings'
import { RECORD_ACTIONS, permFor, type RecordAction, type RecordsTypeRoleGrants, type RecordsTypeTeamGrants } from './records-perms'

type Tx = Transaction<Database>

export interface RecordsMatrixRole {
  key: string
  label: string
  /** True for custom_roles rows; false for host/app-static roles. */
  custom: boolean
}

export interface RecordsEffectiveGrantCell {
  /** What the evaluator answers for a user holding only this role. */
  allowed: boolean
  /** Where the answer comes from: an explicit roleGrants row, the role's
   * slug set, or the admin always-allow bypass. */
  source: 'row' | 'slug' | 'admin'
  /** The role's slug-only answer — what an Inherit cell resolves to. Carried
   * on every cell (row-sourced ones included) so the matrix can render the
   * inherit state honestly when a row override is cleared client-side. */
  fallback: boolean
}

export type RecordsTypeEffectiveGrants = Record<string, Record<RecordAction, RecordsEffectiveGrantCell>>

/** A team row of the matrix: one of the scope's groups. */
export interface RecordsMatrixTeam {
  id: string
  name: string
  icon: string | null
  image: string | null
  archived: boolean
}

/** Response body of the role-grants GET/PUT routes. */
export interface RecordsRoleGrantsView {
  actions: readonly RecordAction[]
  roles: RecordsMatrixRole[]
  grants: RecordsTypeRoleGrants
  effective: RecordsTypeEffectiveGrants
  /** The org's teams (host groups in single mode); archived ones only while they carry grants. */
  teams: RecordsMatrixTeam[]
  teamGrants: RecordsTypeTeamGrants
}

// The org's assignable roles: host + app-static roles (admin and member
// included — the matrix shows admin locked always-allow), then custom roles.
// RLS scopes custom_roles to the active org in multi mode; in single mode
// the table is global. Same query, both modes (the rbac.ts pattern).
export async function listMatrixRoles(tx: Tx): Promise<RecordsMatrixRole[]> {
  const out: RecordsMatrixRole[] = getAllStaticRoles()
    .map(r => ({ key: r.key, label: r.name, custom: false }))
  const customRows = await tx
    .selectFrom('custom_roles')
    .select('name')
    .orderBy('name', 'asc')
    .execute()
  for (const row of customRows) {
    // A custom role shadowed by a static name never resolves (rbac.ts checks
    // static tiers first), so it would be a dead matrix row.
    if (out.some(r => r.key === row.name)) continue
    out.push({ key: row.name, label: row.name, custom: true })
  }
  return out
}

// Builds the full matrix view for one record type. `effective` answers per
// role what the evaluator answers for a user holding only that role: admin
// always passes; a present roleGrants row IS the answer; otherwise the
// role's own slug set decides (see resolveTypePermission's decision order).
export async function buildRoleGrantsView(
  tx: Tx,
  ctx: TenantContext,
  type: RecordTypeSetting
): Promise<RecordsRoleGrantsView> {
  const roles = await listMatrixRoles(tx)
  const grants = type.roleGrants
  const effective: RecordsTypeEffectiveGrants = {}
  // Sequential per role — queries on one transaction connection must not
  // interleave.
  for (const role of roles) {
    const slugs = await getRolePermissions(tx, [role.key], ctx.orgId)
    const cells = {} as Record<RecordAction, RecordsEffectiveGrantCell>
    for (const action of RECORD_ACTIONS) {
      const fallback = slugs.has(permFor(type.key, action))
      if (role.key === 'admin') {
        cells[action] = { allowed: true, source: 'admin', fallback }
      } else {
        const row = grants[role.key]?.[action]
        cells[action] = row === undefined
          ? { allowed: fallback, source: 'slug', fallback }
          : { allowed: row, source: 'row', fallback }
      }
    }
    effective[role.key] = cells
  }
  const teamGrants = type.teamGrants
  const teams = (await listGroups(tx, ctx.orgId))
    .filter(g => !g.archived_at || teamGrants[g.id])
    .map(g => ({ id: g.id, name: g.name, icon: g.icon, image: g.image, archived: !!g.archived_at }))
  const known = new Set(teams.map(t => t.id))
  const liveTeamGrants = Object.fromEntries(Object.entries(teamGrants).filter(([id]) => known.has(id)))
  return { actions: RECORD_ACTIONS, roles, grants, effective, teams, teamGrants: liveTeamGrants }
}
