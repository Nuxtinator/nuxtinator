// The `#ai` client alias — types safe to import in Vue components / composables
// (the admin and org AI pages, the model picker). Server-only helpers live
// behind `#ai/server`.

import type { AiEmbeddingModelInfo } from '#core/ai-fallback/types'
import type { AiModelKind, AiProvider, AiProviderModelInfo } from '../../types/ai-ext'

// Every model the pickers see carries its provider and kind.
export type AiModelInfo = AiProviderModelInfo
export type { AiEmbeddingModelInfo, AiModelKind, AiProvider }

// An org (or the single-tenant scope, orgId null) whose vector indexes were
// built with a model other than the one that resolves for it now.
export interface AiStaleScope {
  orgId: string | null
  model: string
  stored: string[]
}

export interface AiReindexScopeStatus {
  orgId: string | null
  state: 'pending' | 'running' | 'done' | 'error'
  chunks: number
  items: number
  total: number
  current: string | null
  error?: string
}

export interface AiReindexStatus {
  running: boolean
  startedAt: string | null
  finishedAt: string | null
  scopes: AiReindexScopeStatus[]
}

// A host-enabled model as the admin page renders it. `available` is false when
// its provider no longer lists the id (the entry is a placeholder built from
// the stored id alone).
export interface AiEnabledModel extends AiModelInfo {
  available: boolean
}

export interface AiFeatureConfig {
  key: string
  label: string
  description?: string
  // Which kind of model powers the feature; its picker offers only that kind.
  kind: AiModelKind
  // The explicit choice at this scope ('' = unset, fall through).
  model: string
  // What the feature actually resolves to after fallbacks ('' = nothing).
  effectiveModel: string
}

export type AiKeyStatus = 'none' | 'ok' | 'undecryptable'

export interface AiKeyState {
  status: AiKeyStatus
  last4: string
}

// A provider as the host page shows it. `keySource` says where the host's key
// comes from: the environment (`envVar`, not editable on the page), a key
// stored on the page, or nowhere.
export interface AiHostProvider {
  provider: AiProvider
  label: string
  envVar: string
  keySource: 'env' | 'stored' | 'none'
  storedKey: AiKeyState
  catalogAvailable: boolean
}

// A provider as the org page shows it: the org's own key, and whether the
// host's key would cover it otherwise.
export interface AiOrgProvider {
  provider: AiProvider
  label: string
  ownKey: AiKeyState
  hostKey: boolean
  catalogAvailable: boolean
}

// Full payload of GET /api/ai/admin/config.
export interface AiAdminConfig {
  providers: AiHostProvider[]
  modelListAvailable: boolean
  // Every listed model of the providers the host has a key for.
  catalog: AiModelInfo[]
  enabled: AiEnabledModel[]
  defaultModel: string
  features: AiFeatureConfig[]
  // Embedding section: shown when a loaded layer registered an embedding feature.
  embeddingAvailable: boolean
  embeddingModelListAvailable: boolean
  embeddingModel: string
  staleScopes: AiStaleScope[]
}

// Full payload of GET /api/ai/org/config.
export interface AiOrgConfig {
  providers: AiOrgProvider[]
  modelListAvailable: boolean
  // Every listed model of the providers the org has its own key for.
  catalog: AiModelInfo[]
  // The models the org enabled for its own keys.
  enabled: AiEnabledModel[]
  // The models the host enabled, shown under providers the org runs on the host's key.
  hostEnabled: AiModelInfo[]
  allowedModels: AiModelInfo[]
  defaultModel: string
  effectiveDefaultModel: string
  features: AiFeatureConfig[]
  embeddingAvailable: boolean
  embeddingModels: AiEmbeddingModelInfo[]
  embeddingModel: string
  effectiveEmbeddingModel: string
  embeddingStale: boolean
  embeddingStoredModels: string[]
}

// Spend over a period, in USD. `unpriced` counts calls whose cost isn't
// known, so `cost` leaves them out.
export interface AiUsageTotals {
  cost: number
  calls: number
  unpriced: number
}

// The span the spend breakdowns cover: this calendar month, last month, the
// last 30 days, or everything.
export const AI_USAGE_PERIODS = ['month', 'last_month', '30d', 'all'] as const
export type AiUsagePeriod = typeof AI_USAGE_PERIODS[number]

// One row of a breakdown: a layer, feature, subject, model, user, key source or org.
export interface AiUsageGroup extends AiUsageTotals {
  key: string
  label: string
}

export interface AiUsageBreakdowns {
  layer: AiUsageGroup[]
  feature: AiUsageGroup[]
  // What inside a feature the calls ran for (a bot, an inbox); '' when not recorded.
  subject: AiUsageGroup[]
  model: AiUsageGroup[]
  user: AiUsageGroup[]
  keySource: AiUsageGroup[]
  // The host view in multi-tenant mode only; personal-app calls have no org.
  org?: AiUsageGroup[]
}

// Full payload of GET /api/ai/org/usage and GET /api/ai/admin/usage.
export interface AiUsageSummary {
  month: AiUsageTotals
  lastMonth: AiUsageTotals
  allTime: AiUsageTotals
  period: AiUsagePeriod
  // The period's spend, each list ordered by cost.
  by: AiUsageBreakdowns
  // The last 30 days, oldest first; `day` is YYYY-MM-DD and `layers` is that
  // day's cost per layer key.
  daily: (AiUsageTotals & { day: string, layers: Record<string, number> })[]
  // The layers in `daily`, ordered by their 30-day cost.
  dailyLayers: AiUsageGroup[]
}

// One AI round trip, for the org's recent-calls log.
export interface AiUsageCall {
  id: string
  at: string
  layer: string
  feature: string
  // null when the call didn't say what it ran for.
  subject: string | null
  model: string
  keySource: string
  user: string
  promptTokens: number
  completionTokens: number
  cost: number | null
}

// Full payload of GET /api/ai/org/usage-calls; `next` is the cursor for the
// following page, null on the last.
export interface AiUsageCalls {
  calls: AiUsageCall[]
  next: string | null
}
