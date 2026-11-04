import type { AiFeatureDef, AiFeatureKind } from '../../types/ai-ext'

// Runtime registry of AI features. A consumer layer calls `registerAiFeature`
// at boot (e.g. inbox registers 'inbox.draft' and 'inbox.knowledge'); the admin
// AI page lists each and lets an operator pick which enabled model powers it.
// The chosen model is stored per-feature in `core_settings` (see ai-settings).
//
// Same in-process-registry shape as core's app/nav/permission registries.
const _features = new Map<string, AiFeatureDef>()

export function registerAiFeature(feature: AiFeatureDef): void {
  if (!feature || typeof feature.key !== 'string' || feature.key.length === 0) return
  if (_features.has(feature.key)) return
  _features.set(feature.key, feature)
}

export function getAiFeatures(): AiFeatureDef[] {
  return [..._features.values()].sort((a, b) => a.label.localeCompare(b.label))
}

// The kind of model a feature runs on; unregistered features are chat.
export function getAiFeatureKind(key: string): AiFeatureKind {
  return _features.get(key)?.kind ?? 'chat'
}

export function __resetAiFeatureRegistryForTests(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('__resetAiFeatureRegistryForTests is not callable in production')
  }
  _features.clear()
}
