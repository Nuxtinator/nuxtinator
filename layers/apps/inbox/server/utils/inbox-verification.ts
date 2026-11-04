// Address-ownership confirmation for contact-form senders. A form submission
// proves nothing about who owns the address (unlike DKIM-authenticated mail),
// so the auto-ack carries a confirmation link; redeeming it flips the same
// crm_channels.verified flag authenticated inbound mail sets.
import { getSiteUrl } from '#core/server/utils/site-url'
import { consumeChannelVerificationToken } from '#crm/server'
import { inboxListOrgScopes, inboxWithScopeTx } from './inbox-org-routing'

export const INBOX_VERIFY_PATH = '/api/inbox/verify'

// Absolute confirmation link, or null when the deployment has no canonical
// site URL — the ack then goes out without the link rather than not at all.
export function inboxBuildVerificationUrl(token: string): string | null {
  try {
    return `${getSiteUrl()}${INBOX_VERIFY_PATH}/${token}`
  } catch (err) {
    console.warn('[inbox] cannot build a confirmation link:', err instanceof Error ? err.message : err)
    return null
  }
}

// Redeem a token from a session-less request. Tokens are unguessable and
// channels are org-scoped, so the lookup scans org scopes the way the
// contact-form API key routing does. Returns the confirmed address, or null
// when the token is unknown, expired, or already used.
export async function inboxRedeemVerificationToken(token: string): Promise<string | null> {
  if (!/^[a-f0-9]{48}$/.test(token)) return null
  for (const scope of await inboxListOrgScopes()) {
    const channel = await inboxWithScopeTx(scope, tx => consumeChannelVerificationToken(tx, token))
    if (channel) return channel.value
  }
  return null
}
