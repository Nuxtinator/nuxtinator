// PUT /api/ai/org/config
// Update the active org's enabled models, default model, per-feature choices
// and embedding model. Partial: each of enabled_models / default_model /
// feature_models / embedding_model is written only when present. Enabled
// models must be listed by their provider, and a newly added one needs the
// org's own key for its provider. A new embedding model is probed with the org's
// OpenRouter key (its own or the host's) first (see admin/config.put.ts).
// Every chosen id must be '' (unset, fall back to the host) or one the org may
// use right now (see getAllowedModelIds) as it stands after this write, and of
// the right kind (the default is a chat model; a feature's model matches the
// feature's kind). Gated by org.settings.write.
import { readBody } from 'h3'
import { withOrgPermission } from '#tenant/server'
import { getSetting, setSetting } from '#core/server/utils/settings-store'
import { logEvent } from '#core/server/utils/activity-logger'
import type { Permission } from '#core/app/utils/permissions'
import {
  AI_PROVIDER_LABELS,
  AI_SETTINGS_NAMESPACE,
  AI_SETTING_ENABLED_MODELS,
  AI_SETTING_DEFAULT_MODEL,
  AI_SETTING_FEATURE_MODELS,
  AI_SETTING_EMBEDDING_MODEL,
  getAllowedModelIds,
  getAiFeatureKind,
  getOrgApiKey,
  isKnownModel,
  loadModelList,
  modelFitsKind,
  providerOf,
  sanitizeModelIdList,
  sanitizeModelId,
  sanitizeFeatureModels,
  getEmbeddingModelList,
  isKnownEmbeddingModel,
  getProviderApiKey,
  probeEmbeddingModel
} from '#ai/server'

const ORG_SETTINGS_WRITE = 'org.settings.write' as Permission

export default defineEventHandler(async (event) => {
  const body = (await readBody(event)) ?? {}

  return await withOrgPermission(event, ORG_SETTINGS_WRITE, async (tx, ctx) => {
    const changed: Record<string, unknown> = {}

    if (body.enabled_models !== undefined) {
      await loadModelList(tx)
      const ids = sanitizeModelIdList(body.enabled_models).filter(isKnownModel)
      const previous = new Set(await getSetting<string[]>(tx, AI_SETTINGS_NAMESPACE, AI_SETTING_ENABLED_MODELS))
      for (const id of ids.filter(id => !previous.has(id))) {
        const provider = providerOf(id)
        if ((await getOrgApiKey(tx, provider)).status !== 'ok') {
          throw createError({ statusCode: 400, statusMessage: `Add this organization's own ${AI_PROVIDER_LABELS[provider]} key before choosing its models.` })
        }
      }
      await setSetting(tx, AI_SETTINGS_NAMESPACE, AI_SETTING_ENABLED_MODELS, ids)
      changed.enabled_models = ids
    }

    const allowed = new Set(await getAllowedModelIds(tx))

    if (body.default_model !== undefined) {
      const id = sanitizeModelId(body.default_model)
      if (id && !allowed.has(id)) {
        throw createError({ statusCode: 400, statusMessage: 'That model is not available to this organization.' })
      }
      if (id && !modelFitsKind(id, 'chat')) {
        throw createError({ statusCode: 400, statusMessage: 'The default model must be a chat model.' })
      }
      await setSetting(tx, AI_SETTINGS_NAMESPACE, AI_SETTING_DEFAULT_MODEL, id)
      changed.default_model = id
    }

    if (body.embedding_model !== undefined) {
      await getEmbeddingModelList()
      const id = sanitizeModelId(body.embedding_model)
      if (id && !isKnownEmbeddingModel(id)) {
        throw createError({ statusCode: 400, statusMessage: 'That embedding model is not available on OpenRouter.' })
      }
      if (id) {
        const apiKey = await getProviderApiKey(tx, 'openrouter')
        if (apiKey) await probeEmbeddingModel(apiKey, id)
      }
      await setSetting(tx, AI_SETTINGS_NAMESPACE, AI_SETTING_EMBEDDING_MODEL, id)
      changed.embedding_model = id
    }

    if (body.feature_models !== undefined) {
      const map = sanitizeFeatureModels(body.feature_models)
      for (const [feature, id] of Object.entries(map)) {
        if (!allowed.has(id)) {
          throw createError({ statusCode: 400, statusMessage: `The model for "${feature}" is not available to this organization.` })
        }
        if (!modelFitsKind(id, getAiFeatureKind(feature))) {
          throw createError({ statusCode: 400, statusMessage: `The model for "${feature}" is the wrong kind of model for that feature.` })
        }
      }
      await setSetting(tx, AI_SETTINGS_NAMESPACE, AI_SETTING_FEATURE_MODELS, map)
      changed.feature_models = map
    }

    await logEvent({
      eventType: 'ai_org_models_updated',
      tableName: 'core_settings',
      recordId: `${AI_SETTINGS_NAMESPACE}:models`,
      userId: ctx.userId,
      metadata: changed
    }, tx)

    return { ok: true }
  })
})
