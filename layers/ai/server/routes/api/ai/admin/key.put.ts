// PUT /api/ai/admin/key  { provider, key }
// Store the host's key for a provider. Refused when the provider's key is set
// in the environment — the env key always wins, so a stored one would never
// be used. The key is verified against the provider first (a rejected key is a
// 400 and nothing is stored), then encrypted at rest; the response and the
// audit row carry only the last four characters. Operator-admin only.
import { readBody } from 'h3'
import { requireOperatorAdmin } from '#tenant/server'
import { db } from '#core/server/utils/database'
import { logUpdate } from '#core/server/utils/activity-logger'
import {
  AI_PROVIDER_ENV_VARS,
  AI_PROVIDER_LABELS,
  AI_SETTINGS_NAMESPACE,
  apiKeySetting,
  getEnvApiKey,
  isAiProvider,
  setHostApiKey,
  validateApiKey
} from '#ai/server'

export default defineEventHandler(async (event) => {
  const { userId } = await requireOperatorAdmin(event)
  const body = (await readBody(event)) ?? {}
  const provider = body.provider
  if (!isAiProvider(provider)) {
    throw createError({ statusCode: 400, statusMessage: 'Unknown AI provider.' })
  }
  const key = typeof body.key === 'string' ? body.key.trim() : ''
  if (!key) {
    throw createError({ statusCode: 400, statusMessage: 'Enter an API key.' })
  }
  if (key.length > 512) {
    throw createError({ statusCode: 400, statusMessage: `That does not look like a ${AI_PROVIDER_LABELS[provider]} key.` })
  }
  if (getEnvApiKey(provider)) {
    throw createError({
      statusCode: 409,
      statusMessage: `The ${AI_PROVIDER_LABELS[provider]} key is set in the environment (${AI_PROVIDER_ENV_VARS[provider]}) and can't be changed here.`
    })
  }

  const check = await validateApiKey(key, provider)
  if (!check.ok) {
    throw createError({ statusCode: 400, statusMessage: check.message })
  }

  await setHostApiKey(db, provider, key)
  const last4 = key.slice(-4)
  logUpdate('core_host_settings', `${AI_SETTINGS_NAMESPACE}:${apiKeySetting(provider)}`, userId, { setting: 'ai-key', provider, last4 })

  return { ok: true, last4, label: check.label }
})
