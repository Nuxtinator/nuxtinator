// The reminder queue (records_reminders: the day each record's reminder falls
// on, from its due date and reminder option) and the sweep that sends the
// reminders whose day has come, one org at a time.

import { sql, type Transaction } from 'kysely'
import { db } from '#core/server/utils/database'
import { withAdvisoryLock } from '#core/server/utils/advisory-lock'
import { createNotification } from '#core/server/utils/notifications'
import type { Database } from '#core/server/database/schema'
import { isAppEnabledForCurrentOrg, type TenantContext } from '#tenant/server'
import { getRecordType, getRecordTypeFields, recordsAccessGrantingKeys, recordsStatusDefault, type RecordTypeSetting } from './definition-settings'
import { closingRulesOf, isClosedStatus } from './closing'
import { recordsUsersWhoSee } from './share-confirmation'
import { recordsToday } from './due-date'

type Tx = Transaction<Database>

// Cross-replica gate key — committed; distinct from core's 84100723915584200xx,
// inbox's 72039140827165300xx and helpinator's 61204837591746200xx families.
const REMINDERS_LOCK_KEY = '5307719046612830011'
const LOCK_STALE_AFTER_MS = 10 * 60 * 1000
const BATCH = 200

/**
 * Puts the record's reminder in the queue for `remindOn` (YYYY-MM-DD), unsent,
 * or takes it out when there is none or its day has already passed. `setBy`
 * is the person the reminder falls back to.
 */
export async function syncRecordsReminder(
  tx: Tx,
  recordId: string,
  remindOn: string | null,
  setBy: string | null
): Promise<void> {
  if (remindOn === null || remindOn < recordsToday()) {
    await tx.deleteFrom('records_reminders').where('record_id', '=', recordId).execute()
    return
  }
  await tx
    .insertInto('records_reminders')
    .values({ record_id: recordId, remind_on: remindOn, set_by: setBy, sent_at: null })
    .onConflict(oc => oc.column('record_id').doUpdateSet({ remind_on: remindOn, set_by: setBy, sent_at: null }))
    .execute()
}

function isTenancyMode(): boolean {
  try {
    const cfg = useRuntimeConfig()
    const paths = (cfg.tenancyMigrationPaths as string[] | undefined) ?? []
    return paths.length > 0
  } catch {
    return false
  }
}

interface OrgScope {
  id: string
  slug: string
  name: string
}

// One org at a time in multi mode; the single tenant (null) otherwise.
async function listOrgScopes(): Promise<(OrgScope | null)[]> {
  if (!isTenancyMode()) return [null]
  // Raw SQL — `orgs` is a tenancy-only table not in core's Kysely schema.
  const res = await sql<OrgScope>`select id, slug, name from orgs where suspended_at is null`.execute(db)
  return res.rows
}

async function withScopeTx<T>(org: OrgScope | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return await db.transaction().execute(async (tx) => {
    if (org) await sql`select set_config('app.current_org', ${org.id}, true)`.execute(tx)
    return await fn(tx)
  })
}

// A context for the visibility check: the org and no permissions. Cast
// because its shape differs between single and multi mode.
function sweepContext(org: OrgScope | null, userId: string): TenantContext {
  return {
    userId,
    orgId: org?.id ?? null,
    orgSlug: org?.slug ?? null,
    orgName: org?.name ?? null,
    role: null,
    roles: [],
    perms: new Set(),
    clientId: null
  } as unknown as TenantContext
}

interface DueRow {
  record_id: string
  remind_on: string
  set_by: string | null
  record_type: string
  name: string
  status: string | null
  created_by: string
}

// Who a reminder goes to: the record's assignees, else whoever set it (else
// its creator), limited to those who can open it.
async function recipientsOf(tx: Tx, org: OrgScope | null, row: DueRow): Promise<string[]> {
  const grantKeys = await recordsAccessGrantingKeys(tx, row.record_type)
  let userIds: string[] = []
  if (grantKeys.length > 0) {
    const refs = await tx
      .selectFrom('records_user_refs')
      .select('user_id')
      .where('record_id', '=', row.record_id)
      .where('field_key', 'in', grantKeys)
      .execute()
    userIds = [...new Set(refs.map(r => r.user_id))]
  }
  if (userIds.length === 0) userIds = [row.set_by ?? row.created_by]
  return await recordsUsersWhoSee(tx, sweepContext(org, userIds[0]!), row.record_type, row.record_id, userIds)
}

async function sendScope(org: OrgScope | null): Promise<number> {
  return await withScopeTx(org, async (tx) => {
    if (!await isAppEnabledForCurrentOrg(tx, 'records')) return 0
    const rows = await tx
      .selectFrom('records_reminders as r')
      .innerJoin('records_entries as e', 'e.id', 'r.record_id')
      .select(['r.record_id', sql<string>`r.remind_on::text`.as('remind_on'), 'r.set_by', 'e.record_type', 'e.name', 'e.status', 'e.created_by'])
      .where('r.sent_at', 'is', null)
      .where('r.remind_on', '<=', recordsToday())
      .orderBy('r.remind_on', 'asc')
      .limit(BATCH)
      .execute() as DueRow[]

    const types = new Map<string, { type: RecordTypeSetting | null, rules: ReturnType<typeof closingRulesOf> | null, statusDefault: string | null, appOn: boolean }>()
    let sent = 0
    for (const row of rows) {
      let info = types.get(row.record_type)
      if (!info) {
        const type = await getRecordType(tx, row.record_type)
        const defs = type && !type.orphan ? await getRecordTypeFields(tx, row.record_type) : []
        const appOn = !!type && !type.orphan && (!type.manifest?.app || await isAppEnabledForCurrentOrg(tx, type.manifest.app))
        info = { type, rules: type ? closingRulesOf(type, defs) : null, statusDefault: recordsStatusDefault(defs), appOn }
        types.set(row.record_type, info)
      }

      const closed = info.rules ? isClosedStatus(info.rules, row.status ?? info.statusDefault) : false
      if (info.type && info.appOn && !closed) {
        const recipients = await recipientsOf(tx, org, row)
        if (recipients.length > 0) {
          await createNotification(tx, recipients.map(userId => ({
            userId,
            appId: info!.type!.manifest?.app ?? 'records',
            title: `Reminder: ${row.name}`,
            body: info!.type!.labelSingular,
            icon: 'i-lucide-bell',
            link: `/records/${row.record_type}/${row.record_id}`,
            email: 'immediate' as const
          })))
          sent += recipients.length
        }
      }
      // Matched on the day too, so a reminder moved while this ran stays due.
      await tx
        .updateTable('records_reminders')
        .set({ sent_at: sql<Date>`now()` })
        .where('record_id', '=', row.record_id)
        .where('remind_on', '=', row.remind_on)
        .where('sent_at', 'is', null)
        .execute()
    }
    return sent
  })
}

/** Sends every due reminder, one org at a time. Returns how many notifications went out. */
export async function sendDueRecordsReminders(): Promise<number> {
  let sent = 0
  await withAdvisoryLock(REMINDERS_LOCK_KEY, { scope: 'records', label: 'reminders', staleAfterMs: LOCK_STALE_AFTER_MS }, async () => {
    for (const org of await listOrgScopes()) {
      try {
        sent += await sendScope(org)
      } catch (err) {
        console.error(`[records] reminders failed for org ${org?.slug ?? '(single)'}:`, err)
      }
    }
  })
  return sent
}
