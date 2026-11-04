// GET /api/ai/status[?feature=<key>]
// Lightweight readiness probe for consumer client UIs (e.g. the inbox AI
// button) to decide whether to surface AI features. Answered for the active
// org, since both the key and the model choices can differ per org.
//
//   configured        — a key is available (the org's own or the host's)
//   hasEnabledModel    — at least one model is usable by this org
//   featureAvailable   — for the given feature, it resolves to a usable model
//                        (or, with no feature, that a default resolves)
import { getQuery } from 'h3'
import { withOrgContext } from '#tenant/server'
import { isAiConfigured, getAllowedModelIds, resolveDefaultModel, resolveFeatureModel } from '#ai/server'

export default defineEventHandler(async (event) => {
  const feature = String(getQuery(event).feature ?? '').trim()

  return await withOrgContext(event, async (tx) => {
    const [configured, allowed, model] = await Promise.all([
      isAiConfigured(tx),
      getAllowedModelIds(tx),
      feature ? resolveFeatureModel(tx, feature) : resolveDefaultModel(tx)
    ])

    return {
      configured,
      hasEnabledModel: allowed.length > 0,
      featureAvailable: configured && !!model
    }
  })
})
