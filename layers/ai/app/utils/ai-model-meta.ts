import type { AiProvider, AiProviderModelInfo } from '../../types/ai-ext'

// One-line price + context summary for a model, shared by the pickers and the
// enabled-models list: "$3 in · $15 out /M · 200K ctx", "$0.01 / request"
// for request-priced models, or "$0.02 in /M" for decision models, which
// bill input only.

function price(n: number | null): string {
  if (n === null) return '—'
  if (n === 0) return '$0'
  return `$${n < 1 ? Number(n.toFixed(3)) : Number(n.toFixed(2))}`
}

function context(n: number | null): string {
  if (n === null) return ''
  return n >= 1000 ? `${Math.round(n / 1000)}K ctx` : `${n} ctx`
}

export function modelMeta(m: AiProviderModelInfo): string {
  const parts = m.requestPrice !== null
    ? [`${price(m.requestPrice)} / request`]
    : m.kind === 'decision'
      ? [`${price(m.promptPrice)} in /M`]
      : [`${price(m.promptPrice)} in · ${price(m.completionPrice)} out /M`]
  const ctx = context(m.contextLength)
  if (ctx) parts.push(ctx)
  return parts.join(' · ')
}

// Badge text marking a model called directly on a provider's own API, so
// `openai-api/gpt-5` and OpenRouter's `openai/gpt-5` read apart in a mixed list.
// OpenRouter models carry no badge; Tinfoil's has its own.
export function directProviderBadge(provider: AiProvider): string {
  if (provider === 'openai') return 'OpenAI'
  if (provider === 'anthropic') return 'Anthropic'
  return ''
}
