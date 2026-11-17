import { sql } from 'kysely'
import { adminDb } from '#tenant/admin-db'
import { requireHostAdmin } from '#tenant/server'

// Host admin: list every org with member-count, app-count, and the spam
// complaints its mail drew in the last 30 days (its domains share the host's reputation).
export default defineEventHandler(async (event) => {
  await requireHostAdmin(event)

  const rows = await adminDb
    .selectFrom('orgs')
    .leftJoin('memberships', 'memberships.org_id', 'orgs.id')
    .leftJoin('org_apps', 'org_apps.org_id', 'orgs.id')
    .select(eb => [
      'orgs.id as id',
      'orgs.slug as slug',
      'orgs.name as name',
      'orgs.suspended_at as suspended_at',
      'orgs.created_at as created_at',
      eb.fn.count<string>('memberships.id').distinct().as('member_count'),
      eb.fn.count<string>('org_apps.app_id').distinct().as('app_count'),
      eb.selectFrom('mail_suppressions')
        .select(eb.fn.countAll<string>().as('n'))
        .whereRef('mail_suppressions.org_id', '=', 'orgs.id')
        .where('mail_suppressions.reason', '=', 'complaint')
        .where('mail_suppressions.occurred_at', '>', sql<Date>`now() - interval '30 days'`)
        .as('complaint_count')
    ])
    .groupBy(['orgs.id', 'orgs.slug', 'orgs.name', 'orgs.suspended_at', 'orgs.created_at'])
    .orderBy('orgs.name', 'asc')
    .execute()

  return {
    orgs: rows.map(r => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      suspended: !!r.suspended_at,
      created_at: r.created_at,
      member_count: Number(r.member_count),
      app_count: Number(r.app_count),
      complaint_count: Number(r.complaint_count ?? 0)
    }))
  }
})
