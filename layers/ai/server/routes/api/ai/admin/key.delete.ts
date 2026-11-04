// DELETE /api/ai/admin/key?provider=<provider>
// Remove the host's stored key for a provider. Models the host enabled for it
// stay enabled but stop resolving until a key is back (an env key, if set,
// keeps working). Operator-admin only.
import { getQuery } from 'h3'
import { requireOperatorAdmin } from '#tenant/server'
import { db } from '#core/server/utils/database'
import { logUpdate } from '#core/server/utils/activity-logger'
import { AI_SETTINGS_NAMESPACE, apiKeySetting, isAiProvider, setHostApiKey } from '#ai/server'

export default defineEventHandler(async (event) => {
  const { userId } = await requireOperatorAdmin(event)
  const provider = getQuery(event).provider
  if (!isAiProvider(provider)) {
    throw createError({ statusCode: 400, statusMessage: 'Unknown AI provider.' })
  }

  await setHostApiKey(db, provider, '')
  logUpdate('core_host_settings', `${AI_SETTINGS_NAMESPACE}:${apiKeySetting(provider)}`, userId, { setting: 'ai-key', provider, removed: true })

  return { ok: true }
})
