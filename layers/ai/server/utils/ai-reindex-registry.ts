import { sql, type Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import { db } from '#core/server/utils/database'
import type { AiReindexer } from '#core/ai-fallback/types'
import { resolveEmbeddingModel } from './ai-settings'

// Registry of vector indexes plus the "re-embed everything" runner behind the
// AI settings pages. A layer that owns a chunk table registers an AiReindexer
// at boot; the runner walks org scopes (every org in multi mode, one unscoped
// pass in single mode) and asks each reindexer to rebuild its scope with the
// model that resolves for it.
//
// Runs are fire-and-forget in this process; progress lives on a global symbol
// so the status route can report it. Only one run at a time per process.

const _reindexers = new Map<string, AiReindexer>()

export function registerAiReindexer(r: AiReindexer): void {
  if (!r || typeof r.key !== 'string' || !r.key) return
  if (_reindexers.has(r.key)) return
  _reindexers.set(r.key, r)
}

export function getAiReindexers(): AiReindexer[] {
  return [..._reindexers.values()].sort((a, b) => a.label.localeCompare(b.label))
}

// The registered reindexers whose tables exist on this deployment.
export async function getAvailableAiReindexers(): Promise<AiReindexer[]> {
  const out: AiReindexer[] = []
  for (const r of getAiReindexers()) {
    if (!r.available || await r.available()) out.push(r)
  }
  return out
}

export function __resetAiReindexRegistryForTests(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('__resetAiReindexRegistryForTests is not callable in production')
  }
  _reindexers.clear()
}

// --- Scopes ---

function isTenancyMode(): boolean {
  try {
    const cfg = useRuntimeConfig()
    const paths = (cfg.tenancyMigrationPaths as string[] | undefined) ?? []
    return paths.length > 0
  } catch {
    return false
  }
}

// `[null]` in single mode; one id per org in multi mode.
export async function listAiOrgScopes(): Promise<(string | null)[]> {
  if (!isTenancyMode()) return [null]
  const res = await sql<{ id: string }>`select id from orgs order by created_at`.execute(db)
  return res.rows.map(r => r.id)
}

export async function withAiScopeTx<T>(orgId: string | null, fn: (tx: Transaction<Database>) => Promise<T>): Promise<T> {
  return await db.transaction().execute(async (tx) => {
    if (orgId) await sql`select set_config('app.current_org', ${orgId}, true)`.execute(tx)
    return await fn(tx)
  })
}

// --- Staleness ---

export interface AiIndexStaleness {
  // The model that resolves for this scope ('' = none).
  model: string
  // Distinct model ids found in the scope's indexes.
  stored: string[]
  // Items that have never been indexed.
  unindexed: number
  // True when any stored chunk was built with another model, or (with a
  // model set) anything is unindexed.
  stale: boolean
}

// Whether the active scope's indexes were built with the model that resolves
// for it now.
export async function getAiIndexStaleness(tx: Transaction<Database>): Promise<AiIndexStaleness> {
  const model = await resolveEmbeddingModel(tx)
  const stored = new Set<string>()
  let unindexed = 0
  for (const r of await getAvailableAiReindexers()) {
    for (const m of await r.currentModels(tx)) stored.add(m)
    if (model && r.unindexedCount) unindexed += await r.unindexedCount(tx)
  }
  const list = [...stored].sort()
  return { model, stored: list, unindexed, stale: list.some(m => m !== model) || unindexed > 0 }
}

// --- The runner ---

export interface AiReindexScopeStatus {
  orgId: string | null
  state: 'pending' | 'running' | 'done' | 'error'
  chunks: number
  // Sections / pages re-embedded so far, and how many there are in all,
  // summed over the index layers that have started.
  items: number
  total: number
  // Label of the index being rebuilt right now.
  current: string | null
  error?: string
}

export interface AiReindexStatus {
  running: boolean
  startedAt: string | null
  finishedAt: string | null
  scopes: AiReindexScopeStatus[]
}

const STATUS_KEY = Symbol.for('nuxtinator.ai.reindex-status')

function getStatus(): AiReindexStatus {
  const g = globalThis as Record<symbol, unknown>
  if (!g[STATUS_KEY]) g[STATUS_KEY] = { running: false, startedAt: null, finishedAt: null, scopes: [] } satisfies AiReindexStatus
  return g[STATUS_KEY] as AiReindexStatus
}

export function getAiReindexStatus(orgId?: string | null): AiReindexStatus {
  const s = getStatus()
  if (orgId === undefined) return { ...s, scopes: [...s.scopes] }
  return { ...s, scopes: s.scopes.filter(sc => sc.orgId === orgId) }
}

async function reindexScope(scope: AiReindexScopeStatus): Promise<void> {
  scope.state = 'running'
  try {
    for (const r of await getAvailableAiReindexers()) {
      scope.current = r.label
      const chunksBefore = scope.chunks
      // One short tx per step the reindexer takes, never one for the scope.
      const result = await r.run(fn => withAiScopeTx(scope.orgId, fn), {
        total: (n) => {
          scope.total += n
        },
        item: (chunks) => {
          scope.items++
          scope.chunks += chunks
        }
      })
      scope.chunks = chunksBefore + result.chunks
    }
    scope.current = null
    scope.state = 'done'
  } catch (err) {
    scope.state = 'error'
    scope.error = (err as { statusMessage?: string, message?: string })?.statusMessage
      ?? (err as Error)?.message ?? 'failed'
    console.error(`[ai] reindex failed for scope ${scope.orgId ?? 'single'}:`, err)
  }
}

// Start a run over `orgIds` (default: every scope). Returns false when a run
// is already in progress. Awaiting `startAiReindex(...).done` is for tests;
// routes return as soon as the run is scheduled.
export function startAiReindex(orgIds?: (string | null)[]): { started: boolean, done: Promise<void> } {
  const status = getStatus()
  if (status.running) return { started: false, done: Promise.resolve() }
  status.running = true
  status.startedAt = new Date().toISOString()
  status.finishedAt = null
  status.scopes = []
  const done = (async () => {
    try {
      const scopes = orgIds ?? await listAiOrgScopes()
      status.scopes = scopes.map(orgId => ({ orgId, state: 'pending' as const, chunks: 0, items: 0, total: 0, current: null }))
      for (const scope of status.scopes) await reindexScope(scope)
    } catch (err) {
      console.error('[ai] reindex run failed:', err)
    } finally {
      status.running = false
      status.finishedAt = new Date().toISOString()
    }
  })()
  return { started: true, done }
}

// Scopes whose indexes no longer match their resolved model.
export async function listStaleAiScopes(): Promise<{ orgId: string | null, staleness: AiIndexStaleness }[]> {
  const out: { orgId: string | null, staleness: AiIndexStaleness }[] = []
  for (const orgId of await listAiOrgScopes()) {
    const staleness = await withAiScopeTx(orgId, tx => getAiIndexStaleness(tx))
    if (staleness.stale) out.push({ orgId, staleness })
  }
  return out
}
