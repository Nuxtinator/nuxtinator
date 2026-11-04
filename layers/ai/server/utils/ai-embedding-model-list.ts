import type { AiEmbeddingModelInfo } from '#core/ai-fallback/types'
import { getOpenRouterConfig } from './ai-config'

// The live embedding model list — OpenRouter's public `GET /embeddings/models`.
// Same caching shape as ai-model-list.ts: in-process for an hour, served stale
// while a refresh runs, brief backoff after a failed refresh, state on a global
// symbol so lazily imported routes share it.

const CACHE_TTL_MS = 60 * 60 * 1000
const RETRY_AFTER_MS = 60 * 1000

interface EmbeddingListState {
  models: AiEmbeddingModelInfo[]
  byId: Map<string, AiEmbeddingModelInfo>
  nextAttemptAt: number
  inflight: Promise<AiEmbeddingModelInfo[]> | null
}

const STATE_KEY = Symbol.for('nuxtinator.ai.embedding-model-list')

// Under VITEST the list is fixed so suites never touch the network.
export const AI_TEST_EMBEDDING_MODELS: AiEmbeddingModelInfo[] = [
  { id: 'test/embed-small', name: 'Test Embed Small', promptPrice: 0.02, contextLength: 8192 },
  { id: 'test/embed-large', name: 'Test Embed Large', promptPrice: 0.13, contextLength: 8192 }
]

function getState(): EmbeddingListState {
  const g = globalThis as Record<symbol, unknown>
  if (!g[STATE_KEY]) {
    const seed = process.env.VITEST ? AI_TEST_EMBEDDING_MODELS : []
    g[STATE_KEY] = {
      models: seed,
      byId: new Map(seed.map(m => [m.id, m])),
      nextAttemptAt: process.env.VITEST ? Number.POSITIVE_INFINITY : 0,
      inflight: null
    } satisfies EmbeddingListState
  }
  return g[STATE_KEY] as EmbeddingListState
}

function perMillion(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * 1e6 * 1e4) / 1e4
}

// Pure: an OpenRouter `GET /embeddings/models` payload → the list, sorted by name.
export function parseOpenRouterEmbeddingModels(payload: unknown): AiEmbeddingModelInfo[] {
  const data = (payload as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return []
  const out: AiEmbeddingModelInfo[] = []
  const seen = new Set<string>()
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue
    const m = raw as Record<string, unknown>
    const id = typeof m.id === 'string' ? m.id.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    const pricing = (m.pricing && typeof m.pricing === 'object' ? m.pricing : {}) as Record<string, unknown>
    out.push({
      id,
      name: typeof m.name === 'string' && m.name.trim() ? m.name.trim() : id,
      promptPrice: perMillion(pricing.prompt),
      contextLength: typeof m.context_length === 'number' && m.context_length > 0 ? m.context_length : null
    })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

async function refresh(state: EmbeddingListState): Promise<AiEmbeddingModelInfo[]> {
  try {
    const res = await fetch(`${getOpenRouterConfig().baseUrl}/embeddings/models`, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`OpenRouter ${res.status}`)
    const models = parseOpenRouterEmbeddingModels(await res.json())
    if (models.length === 0) throw new Error('OpenRouter returned no embedding models')
    state.models = models
    state.byId = new Map(models.map(m => [m.id, m]))
    state.nextAttemptAt = Date.now() + CACHE_TTL_MS
  } catch (err) {
    console.error('[ai] embedding model list refresh failed:', (err as Error)?.message ?? err)
    state.nextAttemptAt = Date.now() + RETRY_AFTER_MS
  }
  return state.models
}

export async function getEmbeddingModelList(): Promise<AiEmbeddingModelInfo[]> {
  const state = getState()
  if (Date.now() < state.nextAttemptAt) return state.models
  if (!state.inflight) {
    state.inflight = refresh(state).finally(() => {
      state.inflight = null
    })
  }
  if (state.models.length > 0) return state.models
  return await state.inflight
}

export function getEmbeddingModelInfo(id: string): AiEmbeddingModelInfo | undefined {
  return getState().byId.get(id)
}

// With no list loaded there is nothing to check against, so every id passes.
export function isKnownEmbeddingModel(id: string): boolean {
  const state = getState()
  if (state.models.length === 0) return true
  return state.byId.has(id)
}
