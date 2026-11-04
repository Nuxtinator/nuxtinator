// GET /api/ai/embedding-models
// The live OpenRouter embedding model list for the settings pickers. Auth-gated
// only: the list is public data; which model a caller may store is enforced by
// the config endpoints.
import { requireAuth } from '#core/server/utils/auth'
import { getEmbeddingModelList } from '#ai/server'

export default defineEventHandler(async (event) => {
  requireAuth(event)
  return { models: await getEmbeddingModelList() }
})
