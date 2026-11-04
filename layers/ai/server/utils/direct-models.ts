// Catalog parsers for the providers called directly with their own keys
// (OpenAI, Anthropic). Pure — unit-tested without Nuxt or a network.
//
// OpenAI's `GET /models` lists bare ids with no capabilities or prices, so an
// id is kept only when OpenRouter lists the same model (`openai/<id>`) as
// tool-capable, and borrows that entry's name, prices and capability flags.
// Anthropic's `GET /models` reports context window and capabilities itself;
// OpenRouter's matching entry (if any) supplies prices and sampling support.
import type { AiProviderModelInfo } from '../../types/ai-ext'
import { ANTHROPIC_MODEL_PREFIX, OPENAI_MODEL_PREFIX } from './ai-provider'

function dataArray(payload: unknown): Record<string, unknown>[] {
  const data = (payload as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return []
  return data.filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
}

// Model ids (`data[].id`) from either provider's `GET /models` payload.
export function parseProviderModelIds(payload: unknown): string[] {
  const out: string[] = []
  for (const m of dataArray(payload)) {
    if (typeof m.id === 'string' && m.id.trim()) out.push(m.id.trim())
  }
  return out
}

export function openAiModelsFrom(ids: string[], openrouter: AiProviderModelInfo[]): AiProviderModelInfo[] {
  const byId = new Map(openrouter.map(m => [m.id, m]))
  const out: AiProviderModelInfo[] = []
  for (const id of new Set(ids)) {
    const or = byId.get(`openai/${id}`)
    if (!or || or.kind !== 'chat') continue
    out.push({
      ...or,
      id: OPENAI_MODEL_PREFIX + id,
      provider: 'openai',
      reasoning: or.reasoning
        ? { enable: { reasoning_effort: '$EFFORT' }, disable: null, effortMap: {} }
        : null
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

// OpenRouter's slug for an Anthropic model id: the date suffix dropped and
// version digits dotted (`claude-sonnet-4-5-20250929` → `anthropic/claude-sonnet-4.5`).
export function anthropicOpenRouterId(id: string): string {
  const undated = id.replace(/-\d{8}$/, '')
  return `anthropic/${undated.replace(/(\d)-(\d)(?=-|$)/g, '$1.$2')}`
}

function supported(caps: unknown, ...path: string[]): boolean {
  let node: unknown = caps
  for (const key of path) {
    if (!node || typeof node !== 'object') return false
    node = (node as Record<string, unknown>)[key]
  }
  return !!node && typeof node === 'object' && (node as { supported?: unknown }).supported === true
}

export function parseAnthropicModels(payload: unknown, openrouter: AiProviderModelInfo[]): AiProviderModelInfo[] {
  const byId = new Map(openrouter.map(m => [m.id, m]))
  const out: AiProviderModelInfo[] = []
  const seen = new Set<string>()
  for (const m of dataArray(payload)) {
    const id = typeof m.id === 'string' ? m.id.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    const or = byId.get(anthropicOpenRouterId(id))
    const caps = m.capabilities
    const name = typeof m.display_name === 'string' && m.display_name.trim() ? m.display_name.trim() : (or?.name ?? id)
    out.push({
      id: ANTHROPIC_MODEL_PREFIX + id,
      name,
      promptPrice: or?.promptPrice ?? null,
      completionPrice: or?.completionPrice ?? null,
      contextLength: typeof m.max_input_tokens === 'number' && m.max_input_tokens > 0
        ? m.max_input_tokens
        : (or?.contextLength ?? null),
      supportsTemperature: or?.supportsTemperature ?? false,
      supportsCaching: true,
      provider: 'anthropic',
      kind: 'chat',
      supportsImages: caps ? supported(caps, 'image_input') : (or?.supportsImages ?? false),
      requestPrice: null,
      // Reasoning depth is set through `effort`; models that think by default
      // can't have it switched off, so 'off' is not honoured.
      reasoning: supported(caps, 'effort')
        ? { enable: { output_config: { effort: '$EFFORT' } }, disable: null, effortMap: {} }
        : null
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}
