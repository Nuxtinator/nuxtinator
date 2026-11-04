// GET /api/ai/org/config
// The active org's AI settings page payload: each provider's key state (the
// org's own — never the key itself — and whether the host's covers it), the
// catalog of the providers the org has its own key for, the org's enabled
// models and the host's, the models the org may pick from, and its default +
// per-feature choices alongside what each resolves to through the org → host
// chain. Gated by org.settings.write, the same permission as the org's other
// settings tabs.
import { withOrgPermission } from '#tenant/server'
import { getSetting, getHostSetting } from '#core/server/utils/settings-store'
import type { Permission } from '#core/app/utils/permissions'
import {
  AI_PROVIDERS,
  AI_PROVIDER_LABELS,
  AI_SETTINGS_NAMESPACE,
  AI_SETTING_ENABLED_MODELS,
  AI_SETTING_DEFAULT_MODEL,
  AI_SETTING_FEATURE_MODELS,
  AI_SETTING_EMBEDDING_MODEL,
  getHostApiKey,
  isCatalogLoaded,
  isKnownModel,
  loadModelList,
  modelInfoOrPlaceholder,
  getOrgApiKey,
  getAllowedModels,
  getAiFeatures,
  resolveDefaultModel,
  resolveFeatureModel,
  resolveEmbeddingModel,
  getEmbeddingModelList,
  getAiIndexStaleness
} from '#ai/server'

const ORG_SETTINGS_WRITE = 'org.settings.write' as Permission

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, ORG_SETTINGS_WRITE, async (tx) => {
    const list = await loadModelList(tx)
    const providers = await Promise.all(AI_PROVIDERS.map(async (provider) => {
      const own = await getOrgApiKey(tx, provider)
      return {
        provider,
        label: AI_PROVIDER_LABELS[provider],
        ownKey: { status: own.status, last4: own.last4 },
        hostKey: !!process.env.VITEST || !!(await getHostApiKey(tx, provider)),
        catalogAvailable: isCatalogLoaded(provider)
      }
    }))
    const ownKeyed = new Set(providers.filter(p => p.ownKey.status === 'ok').map(p => p.provider))
    const [enabledIds, hostEnabledIds, allowedModels, defaultModel, featureModels, effectiveDefaultModel] = await Promise.all([
      getSetting<string[]>(tx, AI_SETTINGS_NAMESPACE, AI_SETTING_ENABLED_MODELS),
      getHostSetting<string[]>(tx, AI_SETTINGS_NAMESPACE, AI_SETTING_ENABLED_MODELS),
      getAllowedModels(tx),
      getSetting<string>(tx, AI_SETTINGS_NAMESPACE, AI_SETTING_DEFAULT_MODEL),
      getSetting<Record<string, string>>(tx, AI_SETTINGS_NAMESPACE, AI_SETTING_FEATURE_MODELS),
      resolveDefaultModel(tx)
    ])

    const allFeatures = getAiFeatures()
    const embeddingAvailable = allFeatures.some(f => f.kind === 'embedding')
    const features = await Promise.all(
      allFeatures.filter(f => f.kind !== 'embedding').map(async f => ({
        key: f.key,
        label: f.label,
        description: f.description,
        kind: f.kind ?? 'chat',
        model: featureModels[f.key] ?? '',
        effectiveModel: await resolveFeatureModel(tx, f.key)
      }))
    )

    const embeddingModels = embeddingAvailable ? await getEmbeddingModelList() : []
    const [embeddingModel, effectiveEmbeddingModel, staleness] = embeddingAvailable
      ? await Promise.all([
          getSetting<string>(tx, AI_SETTINGS_NAMESPACE, AI_SETTING_EMBEDDING_MODEL),
          resolveEmbeddingModel(tx),
          getAiIndexStaleness(tx)
        ])
      : ['', '', { model: '', stored: [], stale: false }]

    return {
      providers,
      modelListAvailable: list.length > 0,
      catalog: list.filter(m => ownKeyed.has(m.provider)),
      enabled: enabledIds.map(id => ({
        ...modelInfoOrPlaceholder(id),
        available: list.length > 0 && isKnownModel(id)
      })),
      hostEnabled: hostEnabledIds.filter(isKnownModel).map(modelInfoOrPlaceholder),
      allowedModels,
      defaultModel,
      effectiveDefaultModel,
      features,
      embeddingAvailable,
      embeddingModels,
      embeddingModel,
      effectiveEmbeddingModel,
      embeddingStale: staleness.stale,
      embeddingStoredModels: staleness.stored
    }
  })
})
