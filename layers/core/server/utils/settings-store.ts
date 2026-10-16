// Read/write access to the shared settings store. The DB-backed half of the
// settings pattern (the code-owned half is settings-registry.ts). Built on
// `defineSettings` so it shares the registry-first merge rule with the rest of
// the app: code declares what exists + the default, the `core_settings` table
// holds only overrides, reads merge the two.
//
// Org scoping is transparent. In multi-tenant mode `core_settings` is RLS-
// scoped to the active org (set by `defineTenantHandler` / `withOrgPermission`
// inside the request transaction), so a plain `WHERE namespace = …` query
// already returns just this org's rows and inserts default `org_id` to the
// active org. In single-tenant mode there is no org column and the store is
// deployment-global. Callers pass the request `tx` and never touch org_id.
//
// Two scopes share the registry and the merge rule and differ only in table:
// `getSetting` / `setSetting` use `core_settings` (org-scoped as above);
// `getHostSetting` / `setHostSetting` use `core_host_settings`, which the
// tenancy layer never retrofits, so one row is one value for the whole
// deployment in either mode — for settings an operator admin decides once for
// everyone (e.g. which AI models the shared API key may spend on).

import { sql } from 'kysely'
import { defineSettings, type DbClient, type SettingsReader } from './settings'
import { getRegisteredSetting, getRegisteredSettings, type SettingDef } from './settings-registry'

interface SettingRow {
  key: string
  value: unknown
}

export interface SettingValue {
  key: string
  value: unknown
}

// Every registered setting in a namespace, merged with its DB override (or its
// declared default when no row exists). Unregistered DB rows are ignored
// (`includeOrphans` left false). The canonical `defineSettings` usage for this
// store; single-key callers should prefer `getSetting`.
export function settingsReader(namespace: string): SettingsReader<SettingValue> {
  return defineSettings<SettingDef, SettingRow, SettingValue>({
    loadDefaults: () => getRegisteredSettings(namespace),
    loadOverrides: async (tx) => {
      const rows = await tx
        .selectFrom('core_settings')
        .select(['key', 'value'])
        .where('namespace', '=', namespace)
        .execute()
      return new Map(rows.map(r => [r.key, r as SettingRow]))
    },
    keyOf: def => def.key,
    merge: (def, row) => {
      const raw = row ? row.value : def!.default
      return { key: def!.key, value: def!.parse ? def!.parse(raw) : raw }
    }
  })
}

// One setting's effective value: the override row if present, else the declared
// default, coerced through `parse`. Throws if the setting isn't registered —
// the store never serves arbitrary keys, which is what keeps it an override
// store rather than a free-for-all blob.
export async function getSetting<T = unknown>(
  tx: DbClient,
  namespace: string,
  key: string
): Promise<T> {
  return readSetting<T>(tx, 'core_settings', namespace, key)
}

// Host-level counterpart of `getSetting`: the deployment-global override if
// present, else the declared default.
export async function getHostSetting<T = unknown>(
  tx: DbClient,
  namespace: string,
  key: string
): Promise<T> {
  return readSetting<T>(tx, 'core_host_settings', namespace, key)
}

// Persist an override for one setting. The value is coerced through the
// registered `parse` before storage; `writeSetting` holds the jsonb and
// read-then-write mechanics.
export async function setSetting(
  tx: DbClient,
  namespace: string,
  key: string,
  value: unknown
): Promise<void> {
  await writeSetting(tx, 'core_settings', namespace, key, value)
}

// Host-level counterpart of `setSetting`: persists a deployment-global override.
export async function setHostSetting(
  tx: DbClient,
  namespace: string,
  key: string,
  value: unknown
): Promise<void> {
  await writeSetting(tx, 'core_host_settings', namespace, key, value)
}

// Drops the deployment-global override so reads fall back to the declared
// default.
export async function clearHostSetting(
  tx: DbClient,
  namespace: string,
  key: string
): Promise<void> {
  requireSetting(namespace, key)
  await tx
    .deleteFrom('core_host_settings')
    .where('namespace', '=', namespace)
    .where('key', '=', key)
    .execute()
}

// The two tables share one row shape; the scope helpers above differ only in
// which one they hit.
type SettingsTable = 'core_settings' | 'core_host_settings'

async function readSetting<T>(
  tx: DbClient,
  table: SettingsTable,
  namespace: string,
  key: string
): Promise<T> {
  const def = requireSetting(namespace, key)
  const row = await tx
    .selectFrom(table)
    .select('value')
    .where('namespace', '=', namespace)
    .where('key', '=', key)
    .executeTakeFirst()
  const raw = row ? row.value : def.default
  return (def.parse ? def.parse(raw) : raw) as T
}

// The value is written as jsonb via a `::text::jsonb` cast: the intermediate
// ::text stops postgres-js from JSON-encoding the already-stringified value a
// SECOND time, which would store an array/object setting as a jsonb string
// scalar instead of a real jsonb array/object. `core_host_settings` is always
// unique on `(namespace, key)`, so it upserts. `core_settings` uses
// read-then-write to stay mode-agnostic: it is unique on `(namespace, key)` in
// single mode but `(org_id, namespace, key)` in multi mode, so there's no single
// ON CONFLICT target valid in both — and RLS already scopes the read/write to
// the active org.
async function writeSetting(
  tx: DbClient,
  table: SettingsTable,
  namespace: string,
  key: string,
  value: unknown
): Promise<void> {
  const def = requireSetting(namespace, key)
  const parsed = def.parse ? def.parse(value) : value
  const json = sql`${JSON.stringify(parsed ?? null)}::text::jsonb`

  if (table === 'core_host_settings') {
    await tx
      .insertInto(table)
      .values({ namespace, key, value: json })
      .onConflict(oc => oc.columns(['namespace', 'key']).doUpdateSet({ value: json, updated_at: sql`now()` }))
      .execute()
    return
  }

  const existing = await tx
    .selectFrom(table)
    .select('id')
    .where('namespace', '=', namespace)
    .where('key', '=', key)
    .executeTakeFirst()

  if (existing) {
    await tx
      .updateTable(table)
      .set({ value: json, updated_at: sql`now()` })
      .where('namespace', '=', namespace)
      .where('key', '=', key)
      .execute()
  } else {
    await tx
      .insertInto(table)
      .values({ namespace, key, value: json })
      .execute()
  }
}

function requireSetting(namespace: string, key: string): SettingDef {
  const def = getRegisteredSetting(namespace, key)
  if (!def) {
    throw new Error(
      `[settings] "${namespace}:${key}" is not registered — declare it with registerSetting() in a layer plugin`
    )
  }
  return def
}
