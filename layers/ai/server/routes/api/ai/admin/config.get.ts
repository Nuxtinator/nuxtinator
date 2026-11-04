// GET /api/ai/admin/config
// Operator-admin view of the host's AI config: each provider's host key state
// (from the environment, stored here, or none — never the key itself), the
// catalog of the providers the host has a key for, the enabled set (with each
// model's live info, or a placeholder when its provider no longer lists it),
// the host default model, and each registered feature with the host's choice
// and what it resolves to. Gated by requireOperatorAdmin (model enablement
// spends the host keys). Reads the deployment-global store with no org
// context — the /admin/ai page lives under the org-less /admin area and never
// sends one, so the resolved values here are the host chain only.
import { requireOperatorAdmin } from '#tenant/server'
import { db } from '#core/server/utils/database'
import { getHostSetting } from '#core/server/utils/settings-store'
import {
  AI_PROVIDERS,
  AI_PROVIDER_LABELS,
  AI_PROVIDER_ENV_VARS,
  AI_SETTINGS_NAMESPACE,
  AI_SETTING_ENABLED_MODELS,
  AI_SETTING_DEFAULT_MODEL,
  AI_SETTING_FEATURE_MODELS,
  AI_SETTING_EMBEDDING_MODEL,
  getEnvApiKey,
  getHostStoredApiKey,
  isCatalogLoaded,
  isKnownModel,
  loadModelList,
  modelInfoOrPlaceholder,
  getAiFeatures,
  resolveFeatureModel,
  getEmbeddingModelList,
  listStaleAiScopes
} from '#ai/server'

export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)

  const list = await loadModelList(db)
  const embeddingList = await getEmbeddingModelList()
  const [enabledIds, defaultModel, featureModels, embeddingModel] = await Promise.all([
    getHostSetting<string[]>(db, AI_SETTINGS_NAMESPACE, AI_SETTING_ENABLED_MODELS),
    getHostSetting<string>(db, AI_SETTINGS_NAMESPACE, AI_SETTING_DEFAULT_MODEL),
    getHostSetting<Record<string, string>>(db, AI_SETTINGS_NAMESPACE, AI_SETTING_FEATURE_MODELS),
    getHostSetting<string>(db, AI_SETTINGS_NAMESPACE, AI_SETTING_EMBEDDING_MODEL)
  ])

  const providers = await Promise.all(AI_PROVIDERS.map(async (provider) => {
    const stored = await getHostStoredApiKey(db, provider)
    const keySource: 'env' | 'stored' | 'none' = getEnvApiKey(provider)
      ? 'env'
      : stored.status === 'none' ? 'none' : 'stored'
    return {
      provider,
      label: AI_PROVIDER_LABELS[provider],
      envVar: AI_PROVIDER_ENV_VARS[provider],
      keySource,
      storedKey: { status: stored.status, last4: stored.last4 },
      catalogAvailable: isCatalogLoaded(provider)
    }
  }))
  const keyed = new Set(providers
    .filter(p => process.env.VITEST || p.keySource === 'env' || p.storedKey.status === 'ok')
    .map(p => p.provider))

  const enabled = enabledIds.map(id => ({
    ...modelInfoOrPlaceholder(id),
    available: list.length > 0 && isKnownModel(id)
  }))

  // Embedding features have no chat model; they only switch the embedding
  // section on.
  const allFeatures = getAiFeatures()
  const embeddingAvailable = allFeatures.some(f => f.kind === 'embedding')
  const features = await Promise.all(
    allFeatures.filter(f => f.kind !== 'embedding').map(async f => ({
      key: f.key,
      label: f.label,
      description: f.description,
      kind: f.kind ?? 'chat',
      model: featureModels[f.key] ?? '',
      effectiveModel: await resolveFeatureModel(db, f.key)
    }))
  )

  // Orgs whose indexes were built with a model other than the one resolving
  // for them now — the host page offers to rebuild these.
  const staleScopes = embeddingAvailable
    ? (await listStaleAiScopes()).map(s => ({ orgId: s.orgId, model: s.staleness.model, stored: s.staleness.stored }))
    : []

  return {
    providers,
    modelListAvailable: list.length > 0,
    catalog: list.filter(m => keyed.has(m.provider)),
    enabled,
    defaultModel,
    features,
    embeddingAvailable,
    embeddingModelListAvailable: embeddingList.length > 0,
    embeddingModel,
    staleScopes
  }
})
