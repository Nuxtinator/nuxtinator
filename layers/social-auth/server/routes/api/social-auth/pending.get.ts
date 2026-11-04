import { getProviderConfig } from '../../../utils/social-providers'
import { readPendingSignup } from '../../../utils/social-flow'

// What the follow-up step shows: which provider and email are signing in, and
// whether it asks for a display name or the existing account's password.
export default defineEventHandler((event) => {
  const pending = readPendingSignup(event)
  if (!pending) throw createError({ statusCode: 404, statusMessage: 'No sign-up in progress' })
  return {
    provider: getProviderConfig(pending.provider)?.label ?? pending.provider,
    email: pending.profile.email,
    step: pending.step ?? 'name'
  }
})
