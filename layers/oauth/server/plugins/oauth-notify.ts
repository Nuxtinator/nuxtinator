// Default subscriber for `oauth:consent-granted`. Sends an
// anti-phishing email to the user any time a new OAuth client is
// authorised on their account ("X was just connected to your
// account — if this wasn't you, revoke immediately").
//
// Lives in the layer because the email is part of the OAuth
// security narrative, not a per-project feature. Consumer can opt
// out via `runtimeConfig.oauthDisableConsentGrantedEmail = true`
// and ship its own subscriber if it wants different copy/branding/
// localization.
//
// Failures are swallowed: an OAuth grant must never be blocked by
// the email path being down.

import { db } from '#core/server/utils/database'
import { sendEmail } from '#email'
import { tryGetOauthConfig } from '../utils/oauth-config'
import { oauthScopeLabel } from '../utils/oauth-scope-labels'
import type { OauthConsentGrantedPayload } from '../types'

function describeScope(scope: string): string {
  return oauthScopeLabel(scope).title
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function buildEmail(
  payload: OauthConsentGrantedPayload,
  displayName: string,
  profileUrl: string
): { subject: string, html: string, text: string } {
  const scopes = payload.scope.split(/\s+/).filter(Boolean)
  const scopeListHtml = scopes
    .map(s => `<li><strong>${escapeHtml(describeScope(s))}</strong> <code style="color:#666;font-size:.85em">(${escapeHtml(s)})</code></li>`)
    .join('')
  const scopePlain = scopes.map(s => `  - ${describeScope(s)} (${s})`).join('\n')
  const dynamicTag = payload.dynamic ? ' (registered automatically via Dynamic Client Registration)' : ''
  const safeName = escapeHtml(payload.clientName)
  const safeDisplay = escapeHtml(displayName)
  const safeUrl = escapeHtml(profileUrl)

  const subject = `${payload.clientName} was just connected to your account`

  const html = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
  <h2 style="color:#333;margin-top:0">Hello ${safeDisplay},</h2>
  <p style="color:#666;line-height:1.6">
    You just authorized <strong>${safeName}</strong> to access your account${dynamicTag}.
  </p>
  ${scopes.length > 0
    ? `<div style="background:#f3f4f6;border-left:4px solid #000;padding:15px;margin:20px 0;border-radius:0 5px 5px 0">
      <h3 style="margin:0 0 10px 0;color:#333">Permissions granted:</h3>
      <ul style="margin:0;color:#666">${scopeListHtml}</ul>
    </div>`
    : ''}
  <p style="color:#666;line-height:1.6">
    If this wasn't you, revoke access immediately:
  </p>
  <div style="text-align:center;margin-top:20px">
    <a href="${safeUrl}" style="background:#000;color:#fff;padding:12px 24px;text-decoration:none;border-radius:5px;display:inline-block">
      Manage connected apps
    </a>
  </div>
  <p style="color:#666;line-height:1.6;margin-top:20px;font-size:14px">
    If the button doesn't work, copy and paste this link:<br>
    <a href="${safeUrl}" style="color:#000;text-decoration:underline;word-break:break-all">${safeUrl}</a>
  </p>
</div>
`.trim()

  const text = `${payload.clientName} was just connected to your account.

Hello ${displayName},

You just authorized ${payload.clientName} to access your account${dynamicTag}.

${scopes.length > 0 ? `Permissions granted:\n${scopePlain}\n\n` : ''}If this wasn't you, revoke access immediately at: ${profileUrl}`

  return { subject, html, text }
}

export default defineNitroPlugin((nitroApp) => {
  const cfg = useRuntimeConfig()

  // Consumer opt-out — set when the project ships its own subscriber
  // (e.g. branded HTML, localized copy, different transport).
  if (cfg.oauthDisableConsentGrantedEmail) return

  nitroApp.hooks.hook('oauth:consent-granted', async (payload: OauthConsentGrantedPayload) => {
    try {
      const user = await db
        .selectFrom('users')
        .select(['email', 'display_name'])
        .where('id', '=', payload.userId)
        .executeTakeFirst()

      if (!user?.email) {
        console.warn('[oauth-layer] consent-granted: user not found', payload.userId)
        return
      }

      const oauthCfg = tryGetOauthConfig()
      const issuer = oauthCfg?.issuer ?? ''
      const profileUrl = issuer ? `${issuer.replace(/\/$/, '')}/profile` : '/profile'

      const { subject, html, text } = buildEmail(
        payload,
        user.display_name || 'there',
        profileUrl
      )

      await sendEmail({ to: user.email, subject, html, text })
    }
    catch (err) {
      console.error('[oauth-layer] consent-granted: failed to send email', err)
    }
  })
})
