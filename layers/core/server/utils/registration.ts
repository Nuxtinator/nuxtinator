import type { DbClient } from './settings'
import { getHostSetting } from './settings-store'

// Host-level switch for whether people can create their own accounts (the
// register form and first sign-in through a provider). Invites always work.
export const REGISTRATION_SETTINGS_NAMESPACE = 'core'
export const SETTING_SELF_REGISTRATION = 'self_registration'

export async function isSelfRegistrationEnabled(tx: DbClient): Promise<boolean> {
  return await getHostSetting<boolean>(tx, REGISTRATION_SETTINGS_NAMESPACE, SETTING_SELF_REGISTRATION)
}

// Whether a new account may be created without an invite right now. An empty
// deployment always allows it, so the first user can become host admin.
export async function isSelfRegistrationOpen(tx: DbClient): Promise<boolean> {
  if (await isSelfRegistrationEnabled(tx)) return true
  const anyUser = await tx.selectFrom('users').select('id').limit(1).executeTakeFirst()
  return !anyUser
}
