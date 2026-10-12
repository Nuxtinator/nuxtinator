// The `#ai/server` alias surface. Re-exports the multi-provider client, the
// live model list, org/host model + key resolution, and the feature registry
// for consumer layers. A superset of core's `#ai/server` fallback
// (ai-fallback/ai.ts): the shared names behave the same whether or not this
// layer is loaded; `transcribe`, image parts, reasoning levels, providers and
// model kinds exist only here.
//
// Lives in server/exports/ (not server/utils/) so nitro's auto-import scan
// doesn't double-import these names — the source files ARE auto-imported inside
// this layer, and re-exporting auto-imported names from a scanned file logs
// "Duplicated imports".

export * from '#core/ai-fallback/types'
export type * from '../../types/ai-ext'
export * from '#core/ai-fallback/vectors'
export * from '#core/ai-fallback/chunk'

export {
  isAiConfigured,
  resolveAiRun,
  resolveAiEmbedRun,
  complete,
  generate,
  transcribe,
  validateApiKey,
  isEmbeddingConfigured,
  embed,
  probeEmbeddingModel
} from '../utils/ai-client'
export type { AiKeyCheck } from '../utils/ai-client'

export {
  getEmbeddingModelList,
  getEmbeddingModelInfo,
  isKnownEmbeddingModel
} from '../utils/ai-embedding-model-list'

export {
  registerAiReindexer,
  getAiReindexers,
  getAiIndexStaleness,
  listStaleAiScopes,
  listAiOrgScopes,
  withAiScopeTx,
  startAiReindex,
  getAiReindexStatus
} from '../utils/ai-reindex-registry'
export type { AiIndexStaleness, AiReindexStatus, AiReindexScopeStatus } from '../utils/ai-reindex-registry'

export { getEnvApiKey } from '../utils/ai-config'

export {
  AI_PROVIDERS,
  AI_PROVIDER_LABELS,
  AI_PROVIDER_ENV_VARS,
  isAiProvider,
  providerOf,
  wireModelId,
  modelIdFor,
  TINFOIL_MODEL_PREFIX,
  OPENAI_MODEL_PREFIX,
  ANTHROPIC_MODEL_PREFIX
} from '../utils/ai-provider'

export {
  getAllModels,
  getModelList,
  getTranscriptionModels,
  getModelInfo,
  isKnownModel,
  isCatalogLoaded,
  supportsTemperature,
  supportsCaching
} from '../utils/ai-model-list'
export type { CatalogKeys } from '../utils/ai-model-list'

export {
  registerAiFeature,
  getAiFeatures,
  getAiFeatureKind
} from '../utils/ai-feature-registry'

export {
  AI_SETTINGS_NAMESPACE,
  AI_SETTING_ENABLED_MODELS,
  AI_SETTING_DEFAULT_MODEL,
  AI_SETTING_FEATURE_MODELS,
  AI_SETTING_EMBEDDING_MODEL,
  apiKeySetting,
  sanitizeModelIdList,
  sanitizeModelId,
  sanitizeFeatureModels,
  getOrgApiKey,
  setOrgApiKey,
  getHostStoredApiKey,
  setHostApiKey,
  getHostApiKey,
  getProviderApiKey,
  getCatalogKeys,
  loadModelList,
  modelInfoOrPlaceholder,
  modelFitsKind,
  getHostEnabledModelIds,
  getOrgEnabledModelIds,
  getAllowedModelIds,
  getAllowedModels,
  resolveDefaultModel,
  resolveFeatureModel,
  resolveEmbeddingModel
} from '../utils/ai-settings'
export type { AiStoredKey, AiKeyStatus } from '../utils/ai-settings'
