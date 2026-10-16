import { getQuery } from 'h3'
import { sql } from 'kysely'
import { withOrgPermission } from '#tenant/server'

const SORTABLE_COLUMNS = ['display_name', 'email', 'status', 'joined_at'] as const
type SortColumn = typeof SORTABLE_COLUMNS[number]

// Lifecycle order used by the "status" sort: active first, then not-verified
// self-registrations. Pending invites are listed separately (./invites).
const STATUS_ORDER_SQL = `CASE
    WHEN users.verified = true THEN 0
    ELSE 1
  END`

// List members of the active org with pagination, search, and sort.
// Joins `users` (global identity) with `memberships` (org-scoped only by the
// where-clause on `org_id`).
export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, 'org.members.read', async (tx, ctx) => {
    const query = getQuery(event)

    const pageRaw = Number(query.page ?? 1)
    const pageSizeRaw = Number(query.pageSize ?? 50)
    const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1
    const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw >= 1 && pageSizeRaw <= 200
      ? Math.floor(pageSizeRaw)
      : 50

    const q = typeof query.q === 'string' ? query.q.trim() : ''
    const pattern = q ? `%${q}%` : null

    const sortParam = typeof query.sort === 'string' ? query.sort : 'joined_at'
    const sort: SortColumn = (SORTABLE_COLUMNS as readonly string[]).includes(sortParam)
      ? sortParam as SortColumn
      : 'joined_at'
    const dir: 'asc' | 'desc' = query.dir === 'asc' ? 'asc' : 'desc'

    const totalRow = await tx
      .selectFrom('memberships')
      .innerJoin('users', 'users.id', 'memberships.user_id')
      .select(eb => eb.fn.countAll<string>().as('count'))
      .where('memberships.org_id', '=', ctx.orgId)
      .$if(!!pattern, qb => qb.where(eb => eb.or([
        eb('users.display_name', 'ilike', pattern!),
        eb('users.email', 'ilike', pattern!)
      ])))
      .executeTakeFirst()
    const total = Number(totalRow?.count ?? 0)

    const orderExpr = sort === 'display_name'
      ? sql`users.display_name ${sql.raw(dir)}`
      : sort === 'email'
        ? sql`users.email ${sql.raw(dir)}`
        : sort === 'status'
          ? sql`${sql.raw(STATUS_ORDER_SQL)} ${sql.raw(dir)}`
          : sql`memberships.created_at ${sql.raw(dir)}`

    const rows = await tx
      .selectFrom('memberships')
      .innerJoin('users', 'users.id', 'memberships.user_id')
      .select([
        'memberships.id as membership_id',
        'memberships.user_id as user_id',
        'memberships.roles as roles',
        'memberships.created_at as joined_at',
        'users.email as email',
        'users.display_name as display_name',
        'users.avatar as avatar',
        'users.is_admin as is_admin',
        'users.verified as verified'
      ])
      .where('memberships.org_id', '=', ctx.orgId)
      .$if(!!pattern, qb => qb.where(eb => eb.or([
        eb('users.display_name', 'ilike', pattern!),
        eb('users.email', 'ilike', pattern!)
      ])))
      .orderBy(orderExpr)
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .execute()

    // Mirrors `authorizeMemberAvatarEdit`.
    const actor = await tx.selectFrom('users').select('is_admin').where('id', '=', ctx.userId).executeTakeFirst()
    const actorIsAdmin = !!actor?.is_admin
    const canEditAvatars = actorIsAdmin || ctx.perms.has('org.members.edit_avatar')

    const decorated = rows.map((r) => {
      const status: 'active' | 'not_verified' = r.verified ? 'active' : 'not_verified'
      return {
        membership_id: r.membership_id,
        user_id: r.user_id,
        email: r.email,
        display_name: r.display_name,
        avatar: r.avatar || null,
        avatar_editable: canEditAvatars && (actorIsAdmin || !r.is_admin),
        roles: r.roles,
        status,
        joined_at: r.joined_at
      }
    })

    return { rows: decorated, total, page, pageSize }
  })
})
