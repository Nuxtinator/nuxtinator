// User edit of what a connected app may do. The app can only be given
// permissions it asked for at consent; anything left unticked is kept as
// declined. A removed permission stops working on the app's live tokens at
// once; an added one arrives with its next refresh.

import { requireAuth } from '#core/server/utils/auth'
import { applyChoicesToTokens, loadConsentChoices, saveConsentChoices } from '../../../../utils/oauth-consent-choices'
import { hasAnyPermissionScope } from '../../../../utils/oauth-validation'
import { logOauthEvent, OAUTH_EVENTS } from '../../../../utils/oauth-audit'

export default defineEventHandler(async (event) => {
  const user = requireAuth(event)
  const clientId = getRouterParam(event, 'client_id')
  if (!clientId) {
    throw createError({ statusCode: 400, statusMessage: 'client_id is required' })
  }

  const body = await readBody<{ scopes?: unknown }>(event).catch(() => null)
  if (!Array.isArray(body?.scopes)) {
    throw createError({ statusCode: 400, statusMessage: 'scopes must be an array' })
  }
  const ticked = new Set(body.scopes.map(String))

  const current = await loadConsentChoices(user.userId, clientId)
  if (!current) {
    throw createError({ statusCode: 404, statusMessage: 'This app is not connected to your account.' })
  }

  const offered = [...current.granted, ...current.declined]
  const granted = offered.filter(s => ticked.has(s))
  if (!hasAnyPermissionScope(granted)) {
    throw createError({ statusCode: 400, statusMessage: 'Leave at least one permission ticked, or revoke the app.' })
  }
  const declined = offered.filter(s => !ticked.has(s))

  await saveConsentChoices(user.userId, clientId, { granted, declined })
  const removed = current.granted.filter(s => !ticked.has(s))
  const added = granted.filter(s => !current.granted.includes(s))
  await applyChoicesToTokens(user.userId, clientId, { removed, added })

  logOauthEvent({
    event: OAUTH_EVENTS.CONSENT_UPDATED,
    userId: user.userId,
    event3: event,
    metadata: {
      client_id: clientId,
      scope: granted.join(' '),
      removed: removed.join(' '),
      added: added.join(' ')
    }
  })

  return { ok: true }
})
