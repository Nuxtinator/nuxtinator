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

// Settles once boot-time migrations are over: resolves when they finished or
// had nothing to do (`database: false` when there is no DATABASE_URL), rejects
// when they threw. Code that needs migrated tables at boot awaits it.
export interface MigrationsOutcome {
  database: boolean
}

interface ReadyState {
  promise: Promise<MigrationsOutcome>
  resolve: (outcome: MigrationsOutcome) => void
  reject: (err: unknown) => void
  done: boolean
}

const READY_KEY = Symbol.for('nuxtinator.migrations.ready')

function getReady(): ReadyState {
  const g = globalThis as Record<symbol, unknown>
  if (!g[READY_KEY]) {
    let resolve!: ReadyState['resolve']
    let reject!: ReadyState['reject']
    const promise = new Promise<MigrationsOutcome>((res, rej) => {
      resolve = res
      reject = rej
    })
    promise.catch(() => {})
    g[READY_KEY] = { promise, resolve, reject, done: false } satisfies ReadyState
  }
  return g[READY_KEY] as ReadyState
}

export function migrationsReady(): Promise<MigrationsOutcome> {
  return getReady().promise
}

export function settleMigrations(outcome: MigrationsOutcome | { error: unknown }): void {
  const r = getReady()
  if (r.done) return
  r.done = true
  if ('error' in outcome) r.reject(outcome.error)
  else r.resolve(outcome)
}
