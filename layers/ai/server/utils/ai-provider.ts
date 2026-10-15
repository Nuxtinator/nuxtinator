// Provider routing for stored model ids. OpenRouter ids are its own
// `vendor/model` slugs; every other provider's ids carry a prefix OpenRouter
// never uses as a vendor (`tinfoil/`, `openai-api/`, `anthropic-api/`), so the
// catalogs share one id space and OpenRouter's own `openai/…` and
// `anthropic/…` slugs stay unambiguous. Pure — unit-tested without Nuxt.
import { createHash } from 'node:crypto'
import type { AiProvider, AiReasoningLevel, AiReasoningSpec } from '../../types/ai-ext'

export const AI_PROVIDERS: readonly AiProvider[] = ['openrouter', 'tinfoil', 'openai', 'anthropic']

export const AI_PROVIDER_LABELS: Record<AiProvider, string> = {
  openrouter: 'OpenRouter',
  tinfoil: 'Tinfoil',
  openai: 'OpenAI',
  anthropic: 'Anthropic'
}

// The env var that sets the host's key for each provider.
export const AI_PROVIDER_ENV_VARS: Record<AiProvider, string> = {
  openrouter: 'OPENROUTER_API_KEY',
  tinfoil: 'TINFOIL_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY'
}

export const TINFOIL_MODEL_PREFIX = 'tinfoil/'
export const OPENAI_MODEL_PREFIX = 'openai-api/'
export const ANTHROPIC_MODEL_PREFIX = 'anthropic-api/'

const PREFIXES: [AiProvider, string][] = [
  ['tinfoil', TINFOIL_MODEL_PREFIX],
  ['openai', OPENAI_MODEL_PREFIX],
  ['anthropic', ANTHROPIC_MODEL_PREFIX]
]

export function isAiProvider(value: unknown): value is AiProvider {
  return typeof value === 'string' && (AI_PROVIDERS as readonly string[]).includes(value)
}

export function providerOf(modelId: string): AiProvider {
  for (const [provider, prefix] of PREFIXES) {
    if (modelId.startsWith(prefix)) return provider
  }
  return 'openrouter'
}

// The model name the provider's API expects.
export function wireModelId(modelId: string): string {
  for (const [, prefix] of PREFIXES) {
    if (modelId.startsWith(prefix)) return modelId.slice(prefix.length)
  }
  return modelId
}

// The stored id for a provider's own model name.
export function modelIdFor(provider: AiProvider, wireId: string): string {
  const prefix = PREFIXES.find(([p]) => p === provider)?.[1] ?? ''
  return prefix + wireId
}

function substituteEffort(value: unknown, effort: string): unknown {
  if (value === '$EFFORT') return effort
  if (Array.isArray(value)) return value.map(v => substituteEffort(v, effort))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteEffort(v, effort)]))
  }
  return value
}

// Request-body fields for a reasoning level on a model with `spec`. Empty when
// the model has no spec, no level was asked for, or the model can't honour it
// (e.g. 'off' on a model that always reasons).
export function reasoningParams(
  spec: AiReasoningSpec | null | undefined,
  level: AiReasoningLevel | undefined
): Record<string, unknown> {
  if (!spec || !level) return {}
  if (level === 'off') return spec.disable ? structuredClone(spec.disable) : {}
  if (!spec.enable) return {}
  const effort = spec.effortMap[level] ?? level
  return substituteEffort(spec.enable, effort) as Record<string, unknown>
}

// OpenRouter pins a session to one provider endpoint, so calls sharing model + system
// prompt reach the endpoint holding their prompt cache (Gemini's cache is implicit).
export function openRouterSessionId(model: string, system: unknown): string {
  const prefix = typeof system === 'string' ? system : JSON.stringify(system ?? '')
  return `ai-${createHash('sha256').update(`${model}\n${prefix}`).digest('hex').slice(0, 32)}`
}
