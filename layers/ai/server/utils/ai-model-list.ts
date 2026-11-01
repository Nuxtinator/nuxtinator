import type { AiModelInfo } from '#core/ai-fallback/types'
import type { AiProvider, AiProviderModelInfo } from '../../types/ai-ext'
import { getAnthropicConfig, getOpenAiConfig, getOpenRouterConfig, getTinfoilConfig } from './ai-config'
import { AI_PROVIDERS, providerOf } from './ai-provider'
import { parseTinfoilModels } from './tinfoil-models'
import { openAiModelsFrom, parseAnthropicModels, parseProviderModelIds } from './direct-models'

// The live model list, merged from four catalogs: OpenRouter's public
// `GET /models`, Tinfoil's public model catalog, and the `GET /models` lists of
// OpenAI and Anthropic (see direct-models.ts). The catalogs are the only source
// of which models exist, what they're called, what they cost, and which
// parameters they accept — nothing model-specific lives in code. Only
// tool-capable chat models, file-upload transcription models and decision
// models are kept.
//
// OpenAI and Anthropic list models only to a caller with a key, so their
// catalogs load once some key for them is passed in (`CatalogKeys`) and
// refresh with the latest key seen. Tinfoil's catalog is public but is only
// fetched once a Tinfoil key exists somewhere, so deployments that don't use
// it never call it. Both lean on OpenRouter's entries for
// prices and capability flags, so they are rebuilt whenever OpenRouter's
// catalog refreshes.
//
// Each catalog is cached in-process for an hour and served stale while a
// refresh runs, so pickers and generation keep working through a provider
// outage once its list has loaded at least once. A failed refresh backs off
// briefly instead of retrying on every call; a catalog that is still empty
// reads as "unknown" (every id passes) rather than as "no models".
//
// State lives on a global symbol rather than in module scope: Nitro imports
// routes lazily, so two importers may not share a module instance.

const CACHE_TTL_MS = 60 * 60 * 1000
const RETRY_AFTER_MS = 60 * 1000

interface SourceState {
  models: AiProviderModelInfo[]
  // The provider's raw `GET /models` payload (keyed providers only), kept so
  // the models can be rebuilt against a newer OpenRouter catalog.
  payload: unknown
  // The key the catalog is fetched with ('' = no key seen yet). OpenRouter's
  // catalog needs none.
  key: string
  nextAttemptAt: number
  inflight: Promise<void> | null
}

// A key per provider to fetch the keyed catalogs with.
export type CatalogKeys = Partial<Record<AiProvider, string>>

const KEYED_PROVIDERS: AiProvider[] = ['tinfoil', 'openai', 'anthropic']

interface ModelListState {
  sources: Record<AiProvider, SourceState>
  byId: Map<string, AiProviderModelInfo>
}

const STATE_KEY = Symbol.for('nuxtinator.ai.model-list')

function testModel(overrides: Partial<AiProviderModelInfo> & Pick<AiProviderModelInfo, 'id' | 'name'>): AiProviderModelInfo {
  return {
    promptPrice: null,
    completionPrice: null,
    contextLength: null,
    supportsTemperature: false,
    supportsCaching: false,
    provider: 'openrouter',
    kind: 'chat',
    supportsImages: false,
    requestPrice: null,
    reasoning: null,
    ...overrides
  }
}

// Under VITEST the list is fixed so suites never touch the network.
export const AI_TEST_MODELS: AiProviderModelInfo[] = [
  testModel({ id: 'test/alpha', name: 'Test Alpha', promptPrice: 3, completionPrice: 15, contextLength: 200_000, supportsTemperature: true, supportsCaching: true, supportsImages: true }),
  testModel({ id: 'test/beta', name: 'Test Beta', promptPrice: 0.5, completionPrice: 2, contextLength: 128_000, supportsTemperature: true }),
  testModel({ id: 'test/gamma', name: 'Test Gamma' }),
  testModel({ id: 'test/whisper', name: 'Test Whisper', kind: 'transcription', requestPrice: 0.01 }),
  testModel({ id: 'test/decider', name: 'Test Decider', kind: 'decision', promptPrice: 0.02, completionPrice: 0 }),
  testModel({ id: 'tinfoil/test-tau', name: 'Test Tau', provider: 'tinfoil' }),
  testModel({ id: 'openai-api/test-omega', name: 'Test Omega', provider: 'openai', supportsTemperature: true }),
  testModel({ id: 'anthropic-api/test-sigma', name: 'Test Sigma', provider: 'anthropic', supportsCaching: true, supportsImages: true })
]

function emptySource(): SourceState {
  return { models: [], payload: null, key: '', nextAttemptAt: 0, inflight: null }
}

function getState(): ModelListState {
  const g = globalThis as Record<symbol, unknown>
  if (!g[STATE_KEY]) {
    const state: ModelListState = {
      sources: { openrouter: emptySource(), tinfoil: emptySource(), openai: emptySource(), anthropic: emptySource() },
      byId: new Map()
    }
    if (process.env.VITEST) {
      for (const provider of AI_PROVIDERS) {
        state.sources[provider] = {
          ...emptySource(),
          models: AI_TEST_MODELS.filter(m => m.provider === provider),
          nextAttemptAt: Number.POSITIVE_INFINITY
        }
      }
      state.byId = new Map(AI_TEST_MODELS.map(m => [m.id, m]))
    }
    g[STATE_KEY] = state
  }
  return g[STATE_KEY] as ModelListState
}

// OpenRouter prices are USD per token as decimal strings; the pickers show USD
// per million tokens.
function perMillion(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * 1e6 * 1e4) / 1e4
}

// Pure: an OpenRouter `GET /models` payload → the tool-capable models and the
// decision models (output modality `decisions`), sorted by name. Temperature and reasoning support come from `supported_parameters`;
// caching support from the presence of cache-read pricing, which OpenRouter
// reports only for models that honour prompt caching; image input from
// `architecture.input_modalities`; whether reasoning can be switched off from
// `reasoning.mandatory`.
export function parseOpenRouterModels(payload: unknown): AiProviderModelInfo[] {
  const data = (payload as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return []
  const out: AiProviderModelInfo[] = []
  const seen = new Set<string>()
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue
    const m = raw as Record<string, unknown>
    const id = typeof m.id === 'string' ? m.id.trim() : ''
    if (!id || seen.has(id)) continue
    const params = Array.isArray(m.supported_parameters)
      ? (m.supported_parameters.filter(p => typeof p === 'string') as string[])
      : []
    const architecture = (m.architecture && typeof m.architecture === 'object' ? m.architecture : {}) as Record<string, unknown>
    const outputs = Array.isArray(architecture.output_modalities) ? architecture.output_modalities : []
    const isDecision = outputs.includes('decisions')
    if (!isDecision && !params.includes('tools')) continue
    seen.add(id)
    const pricing = (m.pricing && typeof m.pricing === 'object' ? m.pricing : {}) as Record<string, unknown>
    const inputs = Array.isArray(architecture.input_modalities) ? architecture.input_modalities : []
    const reasoningMeta = (m.reasoning && typeof m.reasoning === 'object' ? m.reasoning : {}) as Record<string, unknown>
    const name = typeof m.name === 'string' && m.name.trim() ? m.name.trim() : id
    out.push({
      id,
      name,
      promptPrice: perMillion(pricing.prompt),
      completionPrice: perMillion(pricing.completion),
      contextLength: typeof m.context_length === 'number' && m.context_length > 0 ? m.context_length : null,
      supportsTemperature: params.includes('temperature'),
      supportsCaching: perMillion(pricing.input_cache_read) !== null,
      provider: 'openrouter',
      kind: isDecision ? 'decision' : 'chat',
      // decide() sends text or JSON only.
      supportsImages: !isDecision && inputs.includes('image'),
      requestPrice: null,
      reasoning: !isDecision && params.includes('reasoning')
        ? {
            enable: { reasoning: { effort: '$EFFORT' } },
            // A model that reasons mandatorily rejects `effort: 'none'`.
            disable: reasoningMeta.mandatory === true ? null : { reasoning: { effort: 'none' } },
            effortMap: {}
          }
        : null
    })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

async function fetchCatalog(provider: AiProvider, key: string): Promise<unknown> {
  let url: string
  let headers: Record<string, string> = {}
  switch (provider) {
    case 'tinfoil':
      url = getTinfoilConfig().catalogUrl
      break
    case 'openrouter':
      return await fetchOpenRouterCatalog()
    case 'openai':
      url = `${getOpenAiConfig().baseUrl}/models`
      headers = { Authorization: `Bearer ${key}` }
      break
    case 'anthropic':
      url = `${getAnthropicConfig().baseUrl}/models?limit=1000`
      headers = { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION }
      break
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`${provider} catalog ${res.status}`)
  return await res.json()
}

export const ANTHROPIC_VERSION = '2023-06-01'

// OpenRouter lists only text-output models unless asked for another output
// modality, so decision models come from a second request. That request
// failing leaves the decision models out rather than failing the catalog.
async function fetchOpenRouterCatalog(): Promise<unknown> {
  const base = `${getOpenRouterConfig().baseUrl}/models`
  const get = async (url: string) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`openrouter catalog ${res.status}`)
    return await res.json() as { data?: unknown }
  }
  const [main, decisions] = await Promise.all([
    get(base),
    get(`${base}?output_modalities=decisions`).catch((err) => {
      console.error('[ai] openrouter decision model list failed:', (err as Error)?.message ?? err)
      return { data: [] }
    })
  ])
  const list = (p: { data?: unknown }) => (Array.isArray(p?.data) ? p.data : [])
  return { data: [...list(main), ...list(decisions)] }
}

// A fetched payload → the provider's models. Keyed providers are built
// against OpenRouter's current catalog.
function buildModels(state: ModelListState, provider: AiProvider, payload: unknown): AiProviderModelInfo[] {
  const openrouter = state.sources.openrouter.models
  switch (provider) {
    case 'openrouter': return parseOpenRouterModels(payload)
    case 'tinfoil': return parseTinfoilModels(payload)
    case 'openai': return openAiModelsFrom(parseProviderModelIds(payload), openrouter)
    case 'anthropic': return parseAnthropicModels(payload, openrouter)
  }
}

function rebuildIndex(state: ModelListState): void {
  state.byId = new Map(AI_PROVIDERS.flatMap(p => state.sources[p].models).map(m => [m.id, m]))
}

async function refresh(state: ModelListState, provider: AiProvider): Promise<void> {
  const source = state.sources[provider]
  try {
    const payload = await fetchCatalog(provider, source.key)
    const models = buildModels(state, provider, payload)
    // An empty list keeps whatever loaded before and retries soon. OpenAI's
    // list stays empty until OpenRouter's has loaded; keeping its payload lets
    // the OpenRouter refresh below rebuild it.
    if (models.length === 0) {
      if (provider === 'openai') source.payload = payload
      throw new Error('no usable models')
    }
    source.payload = payload
    source.models = models
    source.nextAttemptAt = Date.now() + CACHE_TTL_MS
    if (provider === 'openrouter') {
      for (const keyed of ['openai', 'anthropic'] as AiProvider[]) {
        const s = state.sources[keyed]
        if (s.payload) s.models = buildModels(state, keyed, s.payload)
      }
    }
    rebuildIndex(state)
  } catch (err) {
    console.error(`[ai] ${provider} model list refresh failed:`, (err as Error)?.message ?? err)
    source.nextAttemptAt = Date.now() + RETRY_AFTER_MS
  }
}

async function ensureSource(state: ModelListState, provider: AiProvider): Promise<void> {
  const source = state.sources[provider]
  if (Date.now() < source.nextAttemptAt) return
  const firstAttempt = source.nextAttemptAt === 0
  if (!source.inflight) {
    source.inflight = refresh(state, provider).finally(() => {
      source.inflight = null
    })
  }
  // Only the first attempt after boot has to wait. Later refreshes, including
  // retries of a catalog that never loaded, run in the background so one
  // provider's outage doesn't stall calls that go to the other.
  if (!firstAttempt) return
  await source.inflight
}

// Every model this deployment can list (chat, transcription and decision), refreshing
// catalogs older than an hour. `keys` lets the Tinfoil, OpenAI and Anthropic
// catalogs load; without a key for them they serve whatever was last loaded.
export async function getAllModels(keys: CatalogKeys = {}): Promise<AiProviderModelInfo[]> {
  const state = getState()
  if (!process.env.VITEST) {
    await ensureSource(state, 'openrouter')
    const providers: AiProvider[] = []
    for (const provider of KEYED_PROVIDERS) {
      const key = keys[provider]
      if (key) state.sources[provider].key = key
      if (state.sources[provider].key) providers.push(provider)
    }
    await Promise.all(providers.map(p => ensureSource(state, p)))
  }
  return AI_PROVIDERS.flatMap(p => state.sources[p].models).sort((a, b) => a.name.localeCompare(b.name))
}

// Whether a provider's catalog has loaded.
export function isCatalogLoaded(provider: AiProvider): boolean {
  return getState().sources[provider].models.length > 0
}

// The cached tool-capable chat model list. An empty result means no catalog
// has loaded (providers unreachable since boot); callers treat that as
// "unknown", not as "no models exist".
export async function getModelList(): Promise<AiModelInfo[]> {
  return (await getAllModels()).filter(m => m.kind === 'chat')
}

export async function getTranscriptionModels(): Promise<AiProviderModelInfo[]> {
  return (await getAllModels()).filter(m => m.kind === 'transcription')
}

export async function getDecisionModels(): Promise<AiProviderModelInfo[]> {
  return (await getAllModels()).filter(m => m.kind === 'decision')
}

// Synchronous reads of the cached list. Callers that need the list to be
// present should `await getAllModels()` first.
export function getModelInfo(id: string): AiProviderModelInfo | undefined {
  return getState().byId.get(id)
}

// Whether a stored id still exists in its provider's catalog. With the
// provider's catalog not loaded there is nothing to check against, so the id
// passes rather than every id failing.
export function isKnownModel(id: string): boolean {
  const state = getState()
  const provider = providerOf(id)
  if (state.sources[provider].models.length === 0) return true
  return state.byId.has(id)
}

// Whether to send sampling params (temperature). Unknown ids default to false —
// a model that rejects sampling params fails hard, whereas losing determinism
// is harmless.
export function supportsTemperature(modelId: string): boolean {
  return getModelInfo(modelId)?.supportsTemperature ?? false
}

// Whether the model honours prompt caching. Unknown ids default to false (cache
// breakpoints become no-ops). Prompt prefixes are kept byte-stable regardless.
export function supportsCaching(modelId: string): boolean {
  return getModelInfo(modelId)?.supportsCaching ?? false
}
