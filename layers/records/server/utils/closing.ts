// Closing a record — the records kernel's archive. A record is closed when
// its status is an option flagged `closed`; types without such an option
// can't be closed. A type may name a closed-reason field (a key_select):
// closing then requires a reason, and reopening clears it. `applyFieldPatch`
// applies these rules, so every write path shares them, and runs the
// registered closing hooks when a record closes (the crm layer revokes
// consent there for reasons flagged `revokesConsent`).

import type { RecordsFieldSetting, RecordTypeSetting } from './definition-settings'

export interface RecordsClosingRules {
  /** Field key of the status column, or null when the type has none. */
  statusKey: string | null
  /** Status option keys that mean closed (deleted ones included). */
  closedStatuses: string[]
  /** Field key of the closed-reason field, or null when the type has none. */
  reasonKey: string | null
}

export function closingRulesOf(type: RecordTypeSetting, defs: RecordsFieldSetting[]): RecordsClosingRules {
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
    reasonKey: reasonField?.key ?? null
  }
}

export function isClosedStatus(rules: RecordsClosingRules, status: unknown): boolean {
  return typeof status === 'string' && rules.closedStatuses.includes(status)
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === ''
}

// Checks a field patch against the closing rules before it is written, and
// adds the reason clear when the patch reopens a record. `before` is the
// record's current field values (null on create). Returns whether the patch
// closes the record, or gives a closed record a new reason — the moments the
// closing hooks run for.
export function enforceClosingRules(
  rules: RecordsClosingRules,
  scalarOps: Map<string, unknown>,
  before: Record<string, unknown> | null
): { closes: boolean } {
  if (!rules.statusKey) return { closes: false }
  const { statusKey, reasonKey } = rules
  const wasClosed = isClosedStatus(rules, before?.[statusKey])
  const nextStatus = scalarOps.has(statusKey) ? scalarOps.get(statusKey) : before?.[statusKey]
  const willBeClosed = isClosedStatus(rules, nextStatus)
  if (!reasonKey) return { closes: willBeClosed && !wasClosed }
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
  return { closes: willBeClosed && (!wasClosed || nextReason !== priorReason) }
}
