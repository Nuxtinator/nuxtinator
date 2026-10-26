// Shared revoke primitives. The token endpoint, the user-facing
// "revoke connected app" route, and the admin "revoke family" route
// all funnel through these — keeping the cascade logic in one place
// avoids drift between paths that should produce identical state.
//
// `revokeFamily` is intentionally idempotent: re-revoking an already-
// revoked family is a no-op (the WHERE clauses skip rows that are
// already revoked) and never throws.

import { db } from '#core/server/utils/database'
import { listOrgScopes, withOrgScope } from '#tenant/server'

export interface RevokeConsentResult {
  consentsRevoked: number
  familiesRevoked: number
}

// Revokes a single token family and cascades the revoke to every
// non-revoked access + refresh token in that family. Single
// transaction so the family/tokens flip together — a partial revoke
// would let one of the two token tables stay live, which the bearer
// validator would honour (it checks the family revoke flag, but the
// per-token revoke is what blocks issuance from cached state).
export async function revokeFamily(familyId: string, reason: string): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('oauth_token_families')
      .set({ revoked: true, revoked_reason: reason, revoked_at: new Date() })
      .where('family_id', '=', familyId)
      .where('revoked', '=', false)
      .execute()

    await trx
      .updateTable('oauth_access_tokens')
      .set({ revoked: true, revoked_reason: reason })
      .where('family_id', '=', familyId)
      .where('revoked', '=', false)
      .execute()

    await trx
      .updateTable('oauth_refresh_tokens')
      .set({ revoked: true, revoked_reason: reason })
      .where('family_id', '=', familyId)
      .where('revoked', '=', false)
      .execute()
  })
}

// Revokes every consent + every active token family for one
// (user_id, client_id) pair. Used by the user-side "Revoke" button
// on the connected-apps page — semantics: "this client is locked
// out of my account, immediately."
//
// Consent revoke spans every resource — a consent row is keyed by
// (client_id, user_id, resource), but from the user's POV "revoke X"
// means "cut off X entirely," so we hit every resource.
//
// In multi mode consents are RLS-scoped per org, so the revoke runs once
// in every org scope; otherwise RLS would hide the rows from the update.
export async function revokeConsentAndFamilies(
  userId: string,
  clientId: string,
  reason: string
): Promise<RevokeConsentResult> {
  // Look up live family ids first (outside the transaction is fine —
  // worst case a concurrent token refresh creates a new row that we
  // don't see, and we'd miss revoking it; the next call would catch
  // it. In practice the user-side flow has no concurrent issuance.)
  const families = await db
    .selectFrom('oauth_token_families')
    .select('family_id')
    .where('user_id', '=', userId)
    .where('client_id', '=', clientId)
    .where('revoked', '=', false)
    .execute()

  let consentsRevoked = 0
  for (const orgId of await listOrgScopes()) {
    const consentResult = await withOrgScope(orgId, tx => tx
      .updateTable('oauth_consents')
      .set({ revoked: true, updated: new Date() })
      .where('user_id', '=', userId)
      .where('client_id', '=', clientId)
      .where('revoked', '=', false)
      .executeTakeFirst())
    consentsRevoked += Number(consentResult.numUpdatedRows ?? 0)
  }

  for (const f of families) {
    await revokeFamily(f.family_id, reason)
  }

  return {
    consentsRevoked,
    familiesRevoked: families.length
  }
}
