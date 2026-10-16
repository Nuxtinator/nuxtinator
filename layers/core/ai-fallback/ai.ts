// Default `#ai/server` implementation when the `@nuxtinator/ai` layer is not
// loaded. `isAiConfigured(tx)` reports false so consumers gate their AI features
// off and never reach the throwing calls; anything that does generate throws
// helpfully. Mirrors email-fallback/email.ts.
//
// Lives outside `server/utils/` so Nuxt's auto-imports don't double up on it.
// The `modules/ai-kernel.ts` Nuxt module wires it as the `#ai/server` alias only
// when no AI layer has set the alias first.

import { createError } from 'h3'
import type {
  AiCompleteOptions,
  AiCompletionRun,
  AiEmbeddingRun,
  AiCompleteResult,
  AiDbClient,
  AiEmbeddingModelInfo,
  AiEmbedOptions,
  AiEmbedResult,
  AiFeature,
  AiGenerateOptions,
  AiGenerateResult,
  AiModelInfo,
  AiReindexer
} from './types'

// Re-export the shared types and the pure vector/chunk helpers so `#ai/server`
// carries them whether the real layer or this fallback is active.
export * from './types'
export * from './vectors'
export * from './chunk'

function notConfigured(): never {
  throw createError({
    statusCode: 503,
    statusMessage:
      'No AI backend is configured. Add the @nuxtinator/ai layer to extends: and set OPENROUTER_API_KEY.'
  })
}

export async function isAiConfigured(_tx: AiDbClient): Promise<boolean> {
  return false
}

export async function resolveAiRun(_tx: AiDbClient, _feature: string, _opts: { model?: string | null } = {}): Promise<AiCompletionRun> {
  notConfigured()
}

export async function resolveAiEmbedRun(_tx: AiDbClient): Promise<AiEmbeddingRun> {
  notConfigured()
}

export async function complete(_opts: AiCompleteOptions): Promise<AiCompleteResult> {
  notConfigured()
}

export async function generate<T = Record<string, unknown>>(
  _opts: AiGenerateOptions
): Promise<AiGenerateResult<T>> {
  notConfigured()
}

// Feature registration is a no-op with no AI layer: consumers still call it at
// boot, but nothing surfaces a model selector because the admin AI page lives in
// the AI layer.
export function registerAiFeature(_feature: AiFeature): void {}

export function getAiFeatures(): AiFeature[] {
  return []
}

export async function getModelList(): Promise<AiModelInfo[]> {
  return []
}

export async function getAllowedModelIds(_tx: AiDbClient): Promise<string[]> {
  return []
}

// No configured model. Consumers must check `isAiConfigured(tx)` before using the
// result — the empty string is never a valid model id.
export async function resolveDefaultModel(_tx: AiDbClient): Promise<string> {
  return ''
}

export async function resolveFeatureModel(_tx: AiDbClient, _feature: string, _override?: string | null): Promise<string> {
  return ''
}

// --- Embeddings: nothing can embed without the AI layer ---

export async function isEmbeddingConfigured(_tx: AiDbClient): Promise<boolean> {
  return false
}

export async function embed(_opts: AiEmbedOptions): Promise<AiEmbedResult> {
  notConfigured()
}

export async function getEmbeddingModelList(): Promise<AiEmbeddingModelInfo[]> {
  return []
}

export async function resolveEmbeddingModel(_tx: AiDbClient): Promise<string> {
  return ''
}

export function registerAiReindexer(_reindexer: AiReindexer): void {}

export function getAiReindexers(): AiReindexer[] {
  return []
}

export function supportsTemperature(_modelId: string): boolean {
  return false
}

export function supportsCaching(_modelId: string): boolean {
  return false
}
