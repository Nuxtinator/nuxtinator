// Closing a record — the CRM's archive. A record is closed when its status
// is an option flagged `closed`; types without such an option can't be
// closed. A type may name a closed-reason field (a key_select): closing then
// requires a reason, reopening clears it, and a reason flagged
// `revokesConsent` (code-declared) revokes every consent on the record's
// addresses. `applyFieldPatch` applies these rules, so every write path
// shares them.

import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { TenantContext } from '#tenant/server'
import type { CrmFieldSetting, CrmRecordTypeSetting } from './definition-settings'
import { getConsentState, revokeConsent } from './consent'
import { recordCrmActivity } from './crm-activity'

type Tx = Transaction<Database>

export interface CrmClosingRules {
  /** Field key of the status column, or null when the type has none. */
  statusKey: string | null
  /** Status option keys that mean closed (deleted ones included). */
  closedStatuses: string[]
  /** Field key of the closed-reason field, or null when the type has none. */
  reasonKey: string | null
  /** Reason option keys that revoke consent when chosen. */
  revokingReasons: string[]
}

export function closingRulesOf(type: CrmRecordTypeSetting, defs: CrmFieldSetting[]): CrmClosingRules {
  const live = (key: string | undefined) => key ? defs.find(d => d.key === key && !d.orphan) : undefined
  const status = live(type.statusField)
  const closedStatuses = status?.column === 'status'
    ? Object.entries(status.options ?? {}).filter(([, o]) => o.closed).map(([k]) => k)
    : []
  const reason = closedStatuses.length > 0 ? live(type.closedReasonField) : undefined
  const reasonField = reason?.kind === 'key_select' ? reason : undefined
  return {
    statusKey: status?.column === 'status' ? status.key : null,
    closedStatuses,
    reasonKey: reasonField?.key ?? null,
    revokingReasons: Object.entries(reasonField?.options ?? {}).filter(([, o]) => o.revokesConsent).map(([k]) => k)
  }
}

export function isClosedStatus(rules: CrmClosingRules, status: unknown): boolean {
  return typeof status === 'string' && rules.closedStatuses.includes(status)
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === ''
}

// Checks a field patch against the closing rules before it is written, and
// adds the reason clear when the patch reopens a record. `before` is the
// record's current field values (null on create). Returns whether the patch
// leaves the record closed with a consent-revoking reason it didn't have.
export function enforceClosingRules(
  rules: CrmClosingRules,
  scalarOps: Map<string, unknown>,
  before: Record<string, unknown> | null
): { revokeConsent: boolean } {
  if (!rules.statusKey || !rules.reasonKey) return { revokeConsent: false }
  const { statusKey, reasonKey } = rules
  const wasClosed = isClosedStatus(rules, before?.[statusKey])
  const nextStatus = scalarOps.has(statusKey) ? scalarOps.get(statusKey) : before?.[statusKey]
  const willBeClosed = isClosedStatus(rules, nextStatus)
  const priorReason = before?.[reasonKey] ?? null
  const nextReason = scalarOps.has(reasonKey) ? scalarOps.get(reasonKey) : priorReason

  // Records closed before the type had a reason field stay editable; only
  // closing, or clearing the reason of a closed record, needs one.
  if (willBeClosed && isBlank(nextReason) && (!wasClosed || scalarOps.has(reasonKey))) {
    throw createError({ statusCode: 400, statusMessage: `A reason is required to close a record: set ${reasonKey}.` })
  }
  if (!willBeClosed && wasClosed && !isBlank(priorReason) && !scalarOps.has(reasonKey)) {
    scalarOps.set(reasonKey, null)
  }
  const revoking = willBeClosed
    && typeof nextReason === 'string'
    && rules.revokingReasons.includes(nextReason)
    && (!wasClosed || nextReason !== priorReason)
  return { revokeConsent: revoking }
}

// Revokes every opted-in consent on the addresses linked to a record, as
// normal consent events with the close as their reason. Consent belongs to
// the address, so records sharing an address lose it too.
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
      await recordCrmActivity(tx, ctx, recordId, 'consent_changed', {
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
