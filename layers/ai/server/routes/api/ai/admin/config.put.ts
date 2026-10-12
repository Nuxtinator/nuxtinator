// PUT /api/ai/admin/config
// Update the host's AI config. Partial: each of enabled_models / default_model
// / feature_models / embedding_model is written only when present. A new
// embedding model is probed with the host key first (one tiny embedding) so a
// model the key cannot use, or one of the wrong width, is refused rather than
// stored. The enabled set is narrowed to models their provider lists; the
// default and every feature choice must be '' (unset) or a member of the
// enabled set as it stands after this write, of the right kind (the default is
// a chat model; a feature's model matches the feature's kind).
// Operator-admin only; writes go to the deployment-global store with no org
// context.
import { readBody } from 'h3'
import { requireOperatorAdmin } from '#tenant/server'
import { db } from '#core/server/utils/database'
import { getHostSetting, setHostSetting } from '#core/server/utils/settings-store'
import { logUpdate } from '#core/server/utils/activity-logger'
import {
  AI_SETTINGS_NAMESPACE,
  AI_SETTING_ENABLED_MODELS,
  AI_SETTING_DEFAULT_MODEL,
  AI_SETTING_FEATURE_MODELS,
  AI_SETTING_EMBEDDING_MODEL,
  loadModelList,
  getEmbeddingModelList,
  getAiFeatureKind,
  isKnownModel,
  isKnownEmbeddingModel,
  modelFitsKind,
  sanitizeModelIdList,
  sanitizeModelId,
  sanitizeFeatureModels,
  getHostApiKey,
  probeEmbeddingModel
} from '#ai/server'

export default defineEventHandler(async (event) => {
  const { userId } = await requireOperatorAdmin(event)
  const body = (await readBody(event)) ?? {}

  await loadModelList(db)

  // Probe outside the transaction: a network call must not hold a DB tx open.
  let embeddingModel: string | undefined
  if (body.embedding_model !== undefined) {
    await getEmbeddingModelList()
    embeddingModel = sanitizeModelId(body.embedding_model)
    if (embeddingModel && !isKnownEmbeddingModel(embeddingModel)) {
      throw createError({ statusCode: 400, statusMessage: 'That embedding model is not available on OpenRouter.' })
    }
    const hostKey = await getHostApiKey(db, 'openrouter')
    if (embeddingModel && hostKey) await probeEmbeddingModel(hostKey, embeddingModel)
  }

  await db.transaction().execute(async (tx) => {
    if (embeddingModel !== undefined) {
      await setHostSetting(tx, AI_SETTINGS_NAMESPACE, AI_SETTING_EMBEDDING_MODEL, embeddingModel)
    }

    if (body.enabled_models !== undefined) {
      const enabled = sanitizeModelIdList(body.enabled_models).filter(isKnownModel)
      await setHostSetting(tx, AI_SETTINGS_NAMESPACE, AI_SETTING_ENABLED_MODELS, enabled)
    }

    const enabledSet = new Set(await getHostSetting<string[]>(tx, AI_SETTINGS_NAMESPACE, AI_SETTING_ENABLED_MODELS))

    if (body.default_model !== undefined) {
      const id = sanitizeModelId(body.default_model)
      if (id && !enabledSet.has(id)) {
        throw createError({ statusCode: 400, statusMessage: 'The default model must be one of the enabled models.' })
      }
      if (id && !modelFitsKind(id, 'chat')) {
        throw createError({ statusCode: 400, statusMessage: 'The default model must be a chat model.' })
      }
      await setHostSetting(tx, AI_SETTINGS_NAMESPACE, AI_SETTING_DEFAULT_MODEL, id)
    }

    if (body.feature_models !== undefined) {
      const map = sanitizeFeatureModels(body.feature_models)
      for (const [feature, id] of Object.entries(map)) {
        if (!enabledSet.has(id)) {
          throw createError({ statusCode: 400, statusMessage: `The model for "${feature}" must be one of the enabled models.` })
        }
        if (!modelFitsKind(id, getAiFeatureKind(feature))) {
          throw createError({ statusCode: 400, statusMessage: `The model for "${feature}" is the wrong kind of model for that feature.` })
        }
      }
      await setHostSetting(tx, AI_SETTINGS_NAMESPACE, AI_SETTING_FEATURE_MODELS, map)
    }
  })

  logUpdate('core_host_settings', `${AI_SETTINGS_NAMESPACE}:models`, userId, { setting: 'ai-models' })

  return { ok: true }
})
