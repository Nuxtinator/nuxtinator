import type { AiProviderModelInfo } from '../../types/ai-ext'

// What one provider round trip cost. Pure, so it is unit-tested without a
// Nuxt build; ai-usage.ts writes the result to the spend log.

// The token counts and cost a provider reports for one round trip.
export interface AiRawUsage {
  prompt_tokens?: unknown
  completion_tokens?: unknown
  cost?: unknown
}

export type AiModelPrices = Pick<AiProviderModelInfo, 'promptPrice' | 'completionPrice' | 'requestPrice'>

export function tokenCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0
}

// USD for one round trip: the provider's own figure when it reports one
// (OpenRouter's `usage.cost`), else the model's catalog prices applied to the
// tokens; null when neither is known.
export function usageCost(usage: AiRawUsage | null, prices: AiModelPrices | undefined): number | null {
  if (typeof usage?.cost === 'number' && Number.isFinite(usage.cost)) return usage.cost
  if (!prices) return null
  const prompt = tokenCount(usage?.prompt_tokens)
  const completion = tokenCount(usage?.completion_tokens)
  const tokenPriced = prices.promptPrice !== null || prices.completionPrice !== null
  if (!tokenPriced || !(prompt + completion)) return prices.requestPrice
  return (prices.requestPrice ?? 0) + (prompt * (prices.promptPrice ?? 0) + completion * (prices.completionPrice ?? 0)) / 1e6
}
