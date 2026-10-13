import { getProviderConfig } from '../../../utils/social-providers'
import { readPendingSignup } from '../../../utils/social-flow'

// What the display-name step shows: which provider and email are signing up.
export default defineEventHandler((event) => {
  const pending = readPendingSignup(event)
  if (!pending) throw createError({ statusCode: 404, statusMessage: 'No sign-up in progress' })
  return {
    provider: getProviderConfig(pending.provider)?.label ?? pending.provider,
    email: pending.profile.email
  }
})
