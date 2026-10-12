// GET /api/ai/models
// The live model list (tool-capable chat models and transcription models from
// every provider catalog loaded so far). Auth-gated only: the list is public data, and which
// models a caller may actually select is enforced by the config endpoints.
import { requireAuth } from '#core/server/utils/auth'
import { getAllModels } from '#ai/server'

export default defineEventHandler(async (event) => {
  requireAuth(event)
  return { models: await getAllModels() }
})
