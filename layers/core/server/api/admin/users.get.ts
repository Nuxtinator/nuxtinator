import { getQuery } from 'h3'
import { db, sql } from '#core/server/utils/database'
import { requireOperatorAdmin } from '#tenant/server'

const SORTABLE_COLUMNS = ['display_name', 'email', 'status', 'created', 'last_login'] as const
type SortColumn = typeof SORTABLE_COLUMNS[number]

// Lifecycle order used by the "status" sort: active first, then not-verified
// self-registrations. Pending invites are not users; see /api/admin/invites.
const STATUS_ORDER_SQL = `CASE
    WHEN users.verified = true THEN 0
    ELSE 1
  END`

export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)

  const query = getQuery(event)

  const pageRaw = Number(query.page ?? 1)
  const pageSizeRaw = Number(query.pageSize ?? 50)
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1
  const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw >= 1 && pageSizeRaw <= 200
    ? Math.floor(pageSizeRaw)
    : 50

  const q = typeof query.q === 'string' ? query.q.trim() : ''

  const sortParam = typeof query.sort === 'string' ? query.sort : 'created'
  const sort: SortColumn = (SORTABLE_COLUMNS as readonly string[]).includes(sortParam)
    ? sortParam as SortColumn
    : 'created'
  const dir: 'asc' | 'desc' = query.dir === 'asc' ? 'asc' : 'desc'

  const pattern = q ? `%${q}%` : null

  const totalRow = await db
    .selectFrom('users')
    .select(eb => eb.fn.countAll<string>().as('count'))
    .$if(!!pattern, qb => qb.where(eb => eb.or([
      eb('users.display_name', 'ilike', pattern!),
      eb('users.email', 'ilike', pattern!)
    ])))
    .executeTakeFirst()
  const total = Number(totalRow?.count ?? 0)

  const orderExpr = sort === 'last_login'
    ? sql`last_login ${sql.raw(dir)} nulls last`
    : sort === 'display_name'
      ? sql`users.display_name ${sql.raw(dir)}`
      : sort === 'email'
        ? sql`users.email ${sql.raw(dir)}`
        : sort === 'status'
          ? sql`${sql.raw(STATUS_ORDER_SQL)} ${sql.raw(dir)}`
          : sql`users.created ${sql.raw(dir)}`

  const rows = await db
    .selectFrom('users')
    .select([
      'users.id',
      'users.display_name',
      'users.email',
      'users.verified',
      'users.created',
      'users.is_admin',
      eb => eb
        .selectFrom('activity_logs')
        .select(eb2 => eb2.fn.max('activity_logs.timestamp').as('last_login'))
        .where('activity_logs.event_type', '=', 'LOGIN')
        .whereRef('activity_logs.user_id', '=', 'users.id')
        .as('last_login')
    ])
    .$if(!!pattern, qb => qb.where(eb => eb.or([
      eb('users.display_name', 'ilike', pattern!),
      eb('users.email', 'ilike', pattern!)
    ])))
    .orderBy(orderExpr)
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .execute()

  // Membership join is tenancy-only — the orgs/memberships tables only exist
  // when the tenancy layer is loaded. Skip cleanly in single-tenant deploys.
  // The `as any` cast keeps this file compiling without tenancy's schema
  // augmentation; the runtime guard above ensures the query never fires when
  // the tables don't exist.
  const tenancyEnabled = useRuntimeConfig(event).public.tenancy === true
  const userIds = rows.map(r => r.id)
  const orgsByUser = new Map<string, { id: string, slug: string, name: string, roles: string[] }[]>()
  if (tenancyEnabled && userIds.length > 0) {
    const memberships = await (db as any)
      .selectFrom('memberships')
      .innerJoin('orgs', 'orgs.id', 'memberships.org_id')
      .select([
        'memberships.user_id as user_id',
        'memberships.roles as roles',
        'orgs.id as id',
        'orgs.slug as slug',
        'orgs.name as name'
      ])
      .where('memberships.user_id', 'in', userIds)
      .orderBy('orgs.name', 'asc')
      .execute() as Array<{ user_id: string, roles: string[], id: string, slug: string, name: string }>
    for (const m of memberships) {
      const list = orgsByUser.get(m.user_id) ?? []
      list.push({ id: m.id, slug: m.slug, name: m.name, roles: m.roles })
      orgsByUser.set(m.user_id, list)
    }
  }

  const decorated = rows.map((row) => {
    const status: 'active' | 'not_verified' = row.verified ? 'active' : 'not_verified'
    return { ...row, status, orgs: orgsByUser.get(row.id) ?? [] }
  })

  return {
    rows: decorated,
    total,
    page,
    pageSize
  }
})
