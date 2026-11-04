// Which migration-name prefixes the boot-time runner held back because a
// Postgres extension they need is missing (see plugins/migrations.ts and
// `runtimeConfig.migrationRequiredExtensions`). Layer code that reads tables
// those migrations create asks here first and degrades instead of failing.
//
// Nitro doesn't await async plugins, so a request can arrive before the
// runner has decided: the answer is a promise the runner settles once.

interface MigrationStatus {
  settled: Promise<Set<string>>
  resolve: (prefixes: Set<string>) => void
  done: boolean
}

const STATUS_KEY = Symbol.for('nuxtinator.migrations.held-back')

function getStatus(): MigrationStatus {
  const g = globalThis as Record<symbol, unknown>
  if (!g[STATUS_KEY]) {
    let resolve!: (prefixes: Set<string>) => void
    const settled = new Promise<Set<string>>((r) => {
      resolve = r
    })
    g[STATUS_KEY] = { settled, resolve, done: false } satisfies MigrationStatus
  }
  return g[STATUS_KEY] as MigrationStatus
}

// Called by the migrations plugin once per boot. Later calls are ignored.
export function setHeldBackMigrations(prefixes: string[]): void {
  const s = getStatus()
  if (s.done) return
  s.done = true
  s.resolve(new Set(prefixes))
}

// True when `prefix` (a key of migrationRequiredExtensions) was held back.
export async function isMigrationHeldBack(prefix: string): Promise<boolean> {
  return (await getStatus().settled).has(prefix)
}
