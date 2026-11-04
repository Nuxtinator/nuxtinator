// DELETE /api/ai/org/key?provider=<provider>
// Remove the active org's own key for a provider. That provider's models fall
// back to the host's (the host-enabled set, if the host has a key for it); the
// org's own model list for it is kept for when a key comes back. Gated by
// org.settings.write.
import { getQuery } from 'h3'
import { withOrgPermission } from '#tenant/server'
import { logEvent } from '#core/server/utils/activity-logger'
import type { Permission } from '#core/app/utils/permissions'
import { AI_SETTINGS_NAMESPACE, apiKeySetting, isAiProvider, setOrgApiKey } from '#ai/server'

const ORG_SETTINGS_WRITE = 'org.settings.write' as Permission

export default defineEventHandler(async (event) => {
  const provider = getQuery(event).provider
  if (!isAiProvider(provider)) {
    throw createError({ statusCode: 400, statusMessage: 'Unknown AI provider.' })
  }

  return await withOrgPermission(event, ORG_SETTINGS_WRITE, async (tx, ctx) => {
    await setOrgApiKey(tx, provider, '')

    await logEvent({
      eventType: 'ai_org_key_removed',
      tableName: 'core_settings',
      recordId: `${AI_SETTINGS_NAMESPACE}:${apiKeySetting(provider)}`,
      userId: ctx.userId,
      metadata: { provider }
    }, tx)

    return { ok: true }
  })
})
