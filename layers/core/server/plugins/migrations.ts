import { Migrator, sql, type Kysely, type Migration, type MigrationProvider } from 'kysely'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createKyselyDb } from '#core/server/utils/db-connection'
import { setHeldBackMigrations } from '#core/server/utils/migration-status'

// Migration runner. Builds its own Kysely client connecting via DATABASE_URL.
// In single-tenant mode that's just the database. In multi-tenant mode it's
// the BYPASSRLS `host_admin` role so ALTER TABLE / RLS-policy operations work.
//
// Two migration sources:
//   1. layerMigrationPaths — every layer's `migrations/` folder (regular
//      `<NNN>_*.ts` files). Set by `modules/migrations.ts`.
//   2. tenancyMigrationPaths — same folders, but only `*_T<NNN>_*.ts` files
//      (per-app tenancy retrofits). Set by `optional-tenancy/modules/tenant-migrations.ts`
//      and ONLY populated when the tenancy layer is loaded.
//
// In single mode, tenancyMigrationPaths is empty / undefined and the
// `_T_` migrations stay on disk unread.

interface ProviderOpts {
  regularFolders: string[]
  tenancyFolders: string[]
  // Names recorded as executed in the database. Any of them without a file
  // on disk belongs to a layer the host no longer loads.
  executedNames: string[]
  // Migration-name prefixes whose pending migrations are held back this run.
  heldBackPrefixes: string[]
}

// Kysely refuses to run at all when an executed migration has no file, so a
// layer removed from the host would block every later migration of every
// other layer. Its executed migrations are re-declared as no-ops: still
// recorded, never run again, never rolled back, tables left as they are.
function removedLayerStub(name: string): Migration {
  return {
    up: async () => {},
    down: async () => {
      throw new Error(`Migration "${name}" belongs to a layer that is no longer loaded and cannot be rolled back`)
    }
  }
}

// The migration table only exists after the first run.
async function readExecutedMigrationNames(db: Kysely<unknown>): Promise<string[]> {
  const table = await sql<{ present: boolean }>`select to_regclass('kysely_migration') is not null as present`.execute(db)
  if (!table.rows[0]?.present) return []
  const rows = await sql<{ name: string }>`select name from kysely_migration`.execute(db)
  return rows.rows.map(r => r.name)
}

// Layers declare the Postgres extensions their migrations need, keyed by
// migration-name prefix (`runtimeConfig.migrationRequiredExtensions`). A key
// may be a whole layer (`helpinator`) or single migrations (`context_013`).
// A prefix whose extension can't be installed has its pending migrations
// skipped with a warning; they run on a later boot once the extension is
// available. Runtime code checks `isMigrationHeldBack(prefix)` to degrade.
async function findHeldBackPrefixes(db: Kysely<unknown>, required: Record<string, string[]>): Promise<string[]> {
  const failures = new Map<string, string | null>()
  const held: string[] = []
  for (const [prefix, extensions] of Object.entries(required)) {
    for (const ext of extensions) {
      if (!failures.has(ext)) {
        try {
          await sql`CREATE EXTENSION IF NOT EXISTS ${sql.id(ext)}`.execute(db)
          failures.set(ext, null)
        } catch (err) {
          failures.set(ext, (err as Error).message)
        }
      }
      const failure = failures.get(ext)
      if (failure) {
        console.warn(`Skipping ${prefix}_* migrations: Postgres extension "${ext}" is not available (${failure}). Install it (or run "CREATE EXTENSION ${ext};" as a superuser) and restart.`)
        held.push(prefix)
        break
      }
    }
  }
  return held
}

class LayeredMigrationProvider implements MigrationProvider {
  constructor(private readonly opts: ProviderOpts) {}

  async getMigrations(): Promise<Record<string, Migration>> {
    const migrations: Record<string, Migration> = {}

    const collect = async (folder: string, includeTenancy: boolean) => {
      let entries: string[] = []
      try {
        entries = await fs.readdir(folder)
      } catch {
        return
      }

      for (const entry of entries) {
        if (!entry.endsWith('.ts') && !entry.endsWith('.js') && !entry.endsWith('.mjs')) continue
        const isTenancy = /_T\d+_/.test(entry)
        if (isTenancy && !includeTenancy) continue
        if (!isTenancy && includeTenancy) continue  // when scanning tenancy folders, ignore regulars (already collected)
        const baseName = entry.replace(/\.(ts|js|mjs)$/, '')
        // Per-app tenancy migrations (`*_T<NNN>_*`) depend on the tenancy
        // layer's own schema (orgs table, `current_org_id()` function). They
        // must run AFTER every other layer's regular migrations and after
        // `tenancy_*` core migrations. Kysely sorts migrations by name, so
        // we suffix-prefix the key with `zzz_` to push them to the back.
        const name = isTenancy ? `zzz_${baseName}` : baseName
        const heldBack = this.opts.heldBackPrefixes.some(p => baseName.startsWith(`${p}_`))
        if (heldBack && !this.opts.executedNames.includes(name)) continue
        if (migrations[name]) {
          throw new Error(`Duplicate migration name "${name}" found in multiple folders`)
        }
        const fullPath = path.join(folder, entry)
        const mod = await import(pathToFileURL(fullPath).href)
        migrations[name] = mod
      }
    }

    for (const folder of this.opts.regularFolders) {
      await collect(folder, false)
    }
    for (const folder of this.opts.tenancyFolders) {
      await collect(folder, true)
    }

    const removed = this.opts.executedNames.filter(name => !migrations[name])
    if (removed.length > 0) {
      console.warn(`Migrations from layers no longer loaded, kept as executed: ${removed.join(', ')}`)
      for (const name of removed) migrations[name] = removedLayerStub(name)
    }

    return migrations
  }
}

export default defineNitroPlugin(async () => {
  try {
    await runMigrations()
  } finally {
    // No-op when runMigrations already recorded the held-back set.
    setHeldBackMigrations([])
  }
})

async function runMigrations(): Promise<void> {
  const config = useRuntimeConfig()
  const databaseUrl = config.databaseUrl || process.env.DATABASE_URL
  if (!databaseUrl) {
    console.warn('DATABASE_URL not set, skipping migrations')
    return
  }

  const adminDb = createKyselyDb<unknown>(databaseUrl, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 30
  })

  const regularFolders = [
    path.join(process.cwd(), 'migrations'),
    ...((config.layerMigrationPaths as string[] | undefined) || []).filter(Boolean)
  ]
  const tenancyFolders = ((config.tenancyMigrationPaths as string[] | undefined) || []).filter(Boolean)

  const executedNames = await readExecutedMigrationNames(adminDb)
  const heldBackPrefixes = await findHeldBackPrefixes(
    adminDb,
    (config.migrationRequiredExtensions as Record<string, string[]> | undefined) || {}
  )
  setHeldBackMigrations(heldBackPrefixes)

  const migrator = new Migrator({
    db: adminDb,
    provider: new LayeredMigrationProvider({ regularFolders, tenancyFolders, executedNames, heldBackPrefixes }),
    // Layers can ship new migrations whose names don't sort after every
    // already-executed one — allow unordered runs.
    allowUnorderedMigrations: true
  })

  const all = await migrator.getMigrations()
  const pending = all.filter(m => !m.executedAt)

  if (pending.length === 0) {
    console.log('Migrations already up-to-date')
    return
  }

  console.log(`Running ${pending.length} pending migration(s)...`)
  for (const m of pending) {
    console.log(`  Migration: ${m.name}`)
  }

  const { error, results } = await migrator.migrateToLatest()

  results?.forEach((r) => {
    if (r.status === 'Success') console.log(`✓ ${r.migrationName}`)
    if (r.status === 'Error') console.error(`✗ ${r.migrationName}`)
  })

  if (error) {
    console.error('Migration failed:', error)
    throw error
  }

  console.log('Migrations complete')
}
