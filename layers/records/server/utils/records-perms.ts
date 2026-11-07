// Permission slug resolution for record routes. A code-declared type may
// carry its own granular slugs by naming a `permissionPrefix` in its manifest
// (contacts uses `crm.contacts`); every other record type — admin-created
// customs included — shares the generic `records.entries.*` set, because the
// permission registry is code-owned and runtime-created types cannot mint
// slugs of their own.

import type { Permission } from '#core/app/utils/permissions'
import { getRegisteredRecordType } from './records-registry'

export const RECORD_ACTIONS = ['read', 'create', 'update', 'delete', 'share', 'view_all'] as const

export type RecordAction = typeof RECORD_ACTIONS[number]

const DEFAULT_PREFIX = 'records.entries'

// Per-type role grants, stored on the type's records_types row under
// config.roleGrants. Semantics are override-with-fallback: a present entry
// (role × action → boolean) IS that role's answer in either direction; an
// absent entry falls back to whether the role's own slug set carries
// permFor(typeKey, action). Only explicit true/false entries are ever
// persisted — see updateTypeRoleGrants (schema-admin.ts) and the evaluator
// (type-permissions.ts).
export type RecordsTypeRoleGrants = Record<string, Partial<Record<RecordAction, boolean>>>

// Per-type team grants, stored under config.teamGrants keyed by group id.
// Teams only add access: an entry is always true, and an absent one leaves
// the answer to roles.
export type RecordsTypeTeamGrants = Record<string, Partial<Record<RecordAction, true>>>

export function permFor(typeKey: string, action: RecordAction): Permission {
  const prefix = getRegisteredRecordType(typeKey)?.permissionPrefix ?? DEFAULT_PREFIX
  return `${prefix}.${action}` as Permission
}
