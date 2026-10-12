import { registerSetting } from '#core/server/utils/settings-registry'
import { registerAdminSection } from '#core/server/utils/admin-section-registry'
import { registerOrgSettingsSection } from '#core/server/utils/org-settings-section-registry'
import {
  AI_SETTINGS_NAMESPACE,
  AI_SETTING_ENABLED_MODELS,
  AI_SETTING_DEFAULT_MODEL,
  AI_SETTING_FEATURE_MODELS,
  AI_SETTING_EMBEDDING_MODEL,
  apiKeySetting,
  sanitizeModelIdList,
  sanitizeModelId,
  sanitizeFeatureModels
} from '../utils/ai-settings'
import { AI_PROVIDERS, AI_PROVIDER_LABELS } from '../utils/ai-provider'

// Single owner of the AI layer's boot registrations: the settings (one
// registration per key serves both the host and org scopes — see
// ai-settings.ts), the operator-admin section, and the org settings section.
//
// Nothing has a model default: a fresh deployment has no enabled models and no
// default model until an operator picks them, so the code never carries a
// model id that goes stale. The host page rides the operator-gated /admin area
// (model enablement spends the host's key); the org page gates on
// org.settings.write like its sibling org settings tabs.
export default defineNitroPlugin(() => {
  registerSetting<string[]>({
    namespace: AI_SETTINGS_NAMESPACE,
    key: AI_SETTING_ENABLED_MODELS,
    default: [],
    parse: sanitizeModelIdList,
    label: 'Enabled models'
  })

  registerSetting<string>({
    namespace: AI_SETTINGS_NAMESPACE,
    key: AI_SETTING_DEFAULT_MODEL,
    default: '',
    parse: sanitizeModelId,
    label: 'Default model'
  })

  registerSetting<Record<string, string>>({
    namespace: AI_SETTINGS_NAMESPACE,
    key: AI_SETTING_FEATURE_MODELS,
    default: {},
    parse: sanitizeFeatureModels,
    label: 'Per-feature model choices'
  })

  // Ciphertext from core's secret-crypto; '' means no key stored.
  for (const provider of AI_PROVIDERS) {
    registerSetting<string>({
      namespace: AI_SETTINGS_NAMESPACE,
      key: apiKeySetting(provider),
      default: '',
      parse: v => (typeof v === 'string' ? v : ''),
      label: `${AI_PROVIDER_LABELS[provider]} API key`
    })
  }

  // The model every vector index in a scope is built with (org overrides host).
  registerSetting<string>({
    namespace: AI_SETTINGS_NAMESPACE,
    key: AI_SETTING_EMBEDDING_MODEL,
    default: '',
    parse: sanitizeModelId,
    label: 'Embedding model'
  })

  registerAdminSection({
    appId: 'ai',
    title: 'AI',
    path: '/admin/ai',
    icon: 'i-lucide-sparkles',
    order: 60
  })

  registerOrgSettingsSection({
    appId: 'ai',
    title: 'AI',
    path: 'ai',
    icon: 'i-lucide-sparkles',
    requiredPermission: 'org.settings.write',
    order: 60
  })
})
