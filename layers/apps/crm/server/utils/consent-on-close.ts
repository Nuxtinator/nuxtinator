// The records closing hook that revokes consent: closing a record with a
// reason flagged `revokesConsent` ("asked to be removed") revokes every
// opted-in consent on the addresses linked to it, as normal consent events
// with the close as their reason. Consent belongs to the address, so records
// sharing an address lose it too. Registered by register-crm.ts.

import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { TenantContext } from '#tenant/server'
import { recordRecordsActivity, type RecordsClosingHook } from '#records/server'
import { getConsentState, revokeConsent } from './consent'

type Tx = Transaction<Database>

export async function revokeConsentOnClose(
  tx: Tx,
  ctx: TenantContext,
  recordId: string,
  reasonLabel: string
): Promise<number> {
  const links = await tx
    .selectFrom('crm_contact_channels as l')
    .innerJoin('crm_channels as c', 'c.id', 'l.channel_id')
    .select(['c.id as channel_id', 'c.channel_type', 'c.value'])
    .where('l.record_id', '=', recordId)
    .execute()
  if (links.length === 0) return 0
  const state = await getConsentState(tx, links.map(l => l.channel_id))
  const note = `Closed: ${reasonLabel}`
  let revoked = 0
  for (const link of links) {
    for (const consent of state.get(link.channel_id) ?? []) {
      if (consent.status !== 'opt_in') continue
      const result = await revokeConsent(tx, ctx, {
        channelId: link.channel_id,
        purpose: consent.purpose,
        source: 'other',
        captureMeta: { note }
      })
      if (!result.changed) continue
      revoked++
      await recordRecordsActivity(tx, ctx, recordId, 'consent_changed', {
        note,
        old: { purpose: consent.purpose, status: 'opt_in' },
        new: {
          channel_id: link.channel_id,
          channel_type: link.channel_type,
          value: link.value,
          purpose: consent.purpose,
          status: 'opt_out',
          source: 'other'
        }
      })
    }
  }
  return revoked
}

export const revokeConsentClosingHook: RecordsClosingHook = async (tx, ctx, event) => {
  if (!event.reason || !event.reasonOption?.revokesConsent) return
  await revokeConsentOnClose(tx, ctx, event.recordId, event.reasonOption.label ?? event.reason)
}
