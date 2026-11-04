import { registerAuthProvider } from '#core/server/utils/auth-provider-registry'
import { decryptSecret } from '#core/server/utils/secret-crypto'
import { db } from '#core/server/utils/database'
import { getProviderConfig, revokeAppleToken } from '../utils/social-providers'

async function revokeAppleIdentity(userId: string): Promise<void> {
  const rows = await db
    .selectFrom('user_identities')
    .select(['client_id', 'refresh_token_enc'])
    .where('user_id', '=', userId)
    .where('provider', '=', 'apple')
    .where('refresh_token_enc', 'is not', null)
    .execute()
  for (const row of rows) {
    try {
      await revokeAppleToken(row.client_id!, decryptSecret(row.refresh_token_enc!))
    } catch (err) {
      console.warn('[social-auth] revoking Apple token failed:', (err as Error).message)
    }
  }
}

// Registers each configured provider with core's sign-in registry, so its
// button appears on the auth pages and it shows up under the account's
// sign-in methods.
export default defineNitroPlugin((nitroApp) => {
  for (const [order, id] of (['google', 'apple'] as const).entries()) {
    const cfg = getProviderConfig(id)
    if (!cfg?.webEnabled) continue
    registerAuthProvider({
      id,
      label: cfg.label,
      icon: cfg.icon,
      startPath: `/api/social-auth/${id}/start`,
      order: 10 + order,
      async getLinkedIdentity(userId) {
        const row = await db
          .selectFrom('user_identities')
          .select('email')
          .where('user_id', '=', userId)
          .where('provider', '=', id)
          .executeTakeFirst()
        return row ? { email: row.email } : null
      },
      async unlink(userId) {
        if (id === 'apple') await revokeAppleIdentity(userId)
        await db.deleteFrom('user_identities').where('user_id', '=', userId).where('provider', '=', id).execute()
      }
    })
  }

  // Apple requires apps to revoke their access when the account is deleted.
  nitroApp.hooks.hook('user.deleting', async ({ userId }) => {
    await revokeAppleIdentity(userId)
  })
})
