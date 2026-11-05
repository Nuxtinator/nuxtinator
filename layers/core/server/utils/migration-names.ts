// How a migration filename maps to its migrator key and when it runs.
// Kysely runs pending migrations in key order, so the key decides the phase:
//
//   <app>_NNN_*     regular  — key is the base name.
//   <app>_TNNN_*    tenancy  — `zzz_` key, runs after every regular migration;
//                              only loaded when the tenancy layer is.
//   <app>_LNNN_*    late     — `zzzz_` key, runs after every tenancy migration.
//   <app>_TLNNN_*   late tenancy — `zzzz_` key, tenancy-only; sorts after the
//                              same app's late migrations (L < T).
//
// Late migrations exist for changes that must follow the tenancy retrofits
// already committed against a table, such as renaming that table.

export type MigrationPhase = 'regular' | 'tenancy' | 'late' | 'late-tenancy'

export interface MigrationName {
  phase: MigrationPhase
  baseName: string
  key: string
  tenancyOnly: boolean
}

const PREFIX: Record<MigrationPhase, string> = {
  'regular': '',
  'tenancy': 'zzz_',
  'late': 'zzzz_',
  'late-tenancy': 'zzzz_'
}

export function classifyMigration(entry: string): MigrationName {
  const baseName = entry.replace(/\.(ts|js|mjs)$/, '')
  let phase: MigrationPhase = 'regular'
  if (/_TL\d+_/.test(baseName)) phase = 'late-tenancy'
  else if (/_T\d+_/.test(baseName)) phase = 'tenancy'
  else if (/_L\d+_/.test(baseName)) phase = 'late'
  return {
    phase,
    baseName,
    key: `${PREFIX[phase]}${baseName}`,
    tenancyOnly: phase === 'tenancy' || phase === 'late-tenancy'
  }
}
